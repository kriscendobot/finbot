import { test } from 'node:test';
import assert from 'node:assert/strict';

import { project } from '../forecaster.js';
import { audit } from '../auditor.js';
import { hashProposal } from '../planner.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// The regime-aware tail-risk floor: the forecast's per-instrument GARCH
// persistence (α+β) tightens the auditor's tail floor. A highly persistent
// regime clusters shocks and fattens the downside beyond what the p05 point
// estimate alone conveys, so it must clear a higher floor before the gate
// approves. This closes the loop from "we measure per-instrument regime" to
// "the regime changes the pre-execution decision".

// A 16-frame series whose vol clusters late; its plain-GARCH fit pins the fixed
// 0.08 / 0.90 split → persistence exactly 0.98 (deterministic, no MLE needed).
const DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];

function readingsOf(series) {
  return series.map((p, i) => ({ t: i, prices: { ATOM: p } }));
}

test('forecaster→auditor: a plain-GARCH fit carries persistence 0.98 into the tail floor', () => {
  const window = readingsOf(DIP);
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: DIP[DIP.length - 1] },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: DIP[DIP.length - 1] }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'regime-tail-floor',
  });
  const forecast = project(
    { world, targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, adaptiveVol: { kind: 'garch' } },
  );
  // The plain fixed-split fit is deterministic: α+β = 0.08 + 0.90 = 0.98.
  assert.equal(forecast.volFit.assets.ATOM.persistence, 0.98);

  // A minimal proposal (empty steps) whose hash reproduces — the tail-risk-floor
  // invariant is evaluated regardless of the other invariants' pass/fail.
  const proposal = {
    steps: [], proposal_hash: hashProposal([]), cited_forecasts: ['f'], cited_analyses: ['a'],
  };
  const auditArgs = (cfg) => audit(
    { proposal, forecast, portfolio: { cash: 1000, balances: { ATOM: 0 } }, prices: { ATOM: 10 }, currentTick: 0 },
    cfg,
  );
  const base = auditArgs({ tailFloorPct: 0.8, regimeTailBump: 0 });
  const tightened = auditArgs({ tailFloorPct: 0.8, regimeTailBump: 0.15 });
  const baseTail = base.invariant_results.find((r) => r.name === 'tail-risk-floor');
  const tightTail = tightened.invariant_results.find((r) => r.name === 'tail-risk-floor');
  assert.doesNotMatch(baseTail.detail, /regime-tightened/);
  // 0.8 + 0.15·stress(1.0) = 0.95 floor; the detail names the tightening.
  assert.match(tightTail.detail, /regime-tightened.*persistence 0\.980 of ATOM/);
  assert.match(tightTail.detail, /95\.0% of NAV/);
});

test('ooda-cycle: adaptive vol on defaults the regime tail-floor bump (0.1) into the gate', async () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'regime-tail-floor-ooda',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 16; i += 1) sim.tick();

  const result = await runOodaCycle({
    world,
    history: sim.history,
    cycleId: 'regime-tail-floor-ooda',
    config: {
      windowTicks: 10,
      fitWindowTicks: 16,
      oracle: { thresholdBps: 5 },
      analyzer: { scoreFloor: 0 },
      forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
      bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
      // No auditor.regimeTailBump → the ooda-cycle defaults it to 0.1 because
      // adaptiveVol is on. Persistence 0.98 → floor tightens 0.5 → 0.6.
      auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11 },
    },
  });

  assert.equal(result.walletTouched, false);
  if (result.audit) {
    const tail = result.audit.invariant_results.find((r) => r.name === 'tail-risk-floor');
    assert.match(tail.detail, /regime-tightened from 50\.0% on persistence 0\.980/);
    assert.match(tail.detail, /60\.0% of NAV/);
  }
});

test('ooda-cycle: adaptive vol off leaves the tail floor untightened', async () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'regime-tail-floor-off',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 16; i += 1) sim.tick();

  const result = await runOodaCycle({
    world,
    history: sim.history,
    cycleId: 'regime-tail-floor-off',
    config: {
      windowTicks: 10,
      oracle: { thresholdBps: 5 },
      analyzer: { scoreFloor: 0 },
      forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100 }, // no adaptiveVol
      bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
      auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11 },
    },
  });

  assert.equal(result.walletTouched, false);
  if (result.audit) {
    const tail = result.audit.invariant_results.find((r) => r.name === 'tail-risk-floor');
    assert.doesNotMatch(tail.detail, /regime-tightened/);
  }
});
