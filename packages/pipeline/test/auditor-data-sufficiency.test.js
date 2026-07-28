import { test } from 'node:test';
import assert from 'node:assert/strict';

import { project } from '../forecaster.js';
import { audit } from '../auditor.js';
import { hashProposal } from '../planner.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// The forecast-data-sufficiency invariant: an opt-in pre-execution gate on how
// far the forecast projects past its observed window. Off by default the
// invariant is not even emitted, so the verdict is byte-identical to before;
// turned on, a forecast that outruns its evidence fails the gate. This is the
// pre-execution sibling of pricing-freshness (a forecast can be fresh yet thin).

const DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];

function readingsOf(series) {
  return series.map((p, i) => ({ t: i, prices: { ATOM: p } }));
}

function forecastWith(window, config) {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: window[window.length - 1].prices.ATOM },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: window[window.length - 1].prices.ATOM }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'auditor-data-sufficiency',
  });
  return project(
    { world, targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: config.horizon, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
}

const PROPOSAL = {
  steps: [], proposal_hash: hashProposal([]), cited_forecasts: ['f'], cited_analyses: ['a'],
};
const AUDIT_INPUT = (forecast) => ({
  proposal: PROPOSAL, forecast,
  portfolio: { cash: 1000, balances: { ATOM: 0 } }, prices: { ATOM: 10 }, currentTick: 0,
});

test('audit: default (min 0) does not emit the invariant — verdict byte-identical', () => {
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const off = audit(AUDIT_INPUT(forecast), { tailFloorPct: 0.5 });
  const explicitZero = audit(AUDIT_INPUT(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 0 });
  assert.deepEqual(off, explicitZero);
  assert.ok(!off.invariant_results.some((r) => r.name === 'forecast-data-sufficiency'));
});

test('audit: gate on, forecast clears coverage → passes', () => {
  // 16-frame window (15 returns) / 5-tick horizon → coverage 3.0, well above 1.0.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const v = audit(AUDIT_INPUT(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  const inv = v.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
  assert.ok(inv);
  assert.equal(inv.pass, true);
  assert.ok(!v.failed_invariants.includes('forecast-data-sufficiency'));
  assert.match(inv.detail, /coverage 3\.000/);
});

test('audit: gate on, forecast below coverage → rejected', () => {
  // 4-frame window (3 returns) / 20-tick horizon → coverage 0.15, below 1.0.
  const forecast = forecastWith(readingsOf(DIP.slice(0, 4)), { horizon: 20 });
  const v = audit(AUDIT_INPUT(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  const inv = v.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
  assert.equal(inv.pass, false);
  assert.equal(v.verdict, 'rejected');
  assert.ok(v.failed_invariants.includes('forecast-data-sufficiency'));
  assert.match(inv.detail, /forecast flags scarce/);
});

test('audit: gate on but a legacy forecast lacks the descriptor → vacuously passes', () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'auditor-data-sufficiency-legacy',
  });
  // reportDataSufficiency NOT set → forecast has no dataSufficiency field.
  const legacy = project(
    { world, targetWeights: { ATOM: 0.5 }, readings: readingsOf(DIP) },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false },
  );
  assert.equal(legacy.dataSufficiency, null);
  const v = audit(AUDIT_INPUT(legacy), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  const inv = v.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
  assert.equal(inv.pass, true);
  assert.match(inv.detail, /no data-sufficiency descriptor/);
});

test('ooda-cycle: the lone auditor gate knob auto-enables the report and bites', async () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'data-sufficiency-ooda',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 16; i += 1) sim.tick();

  // windowTicks 10 → 9 observed returns; a 20-tick horizon → coverage 0.45,
  // below the 1.0 the operator required. Only the auditor knob is set; the
  // ooda-cycle must auto-enable the forecaster report so the gate has data.
  const result = await runOodaCycle({
    world,
    history: sim.history,
    cycleId: 'data-sufficiency-ooda',
    config: {
      windowTicks: 10,
      oracle: { thresholdBps: 5 },
      analyzer: { scoreFloor: 0 },
      forecaster: { ensembleSize: 8, horizon: 20, baseSeed: 100 },
      bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
      auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11, dataSufficiencyMinCoverage: 1 },
    },
  });

  assert.equal(result.walletTouched, false);
  assert.ok(result.forecast.dataSufficiency, 'the gate auto-enabled the forecaster report');
  assert.equal(result.forecast.dataSufficiency.horizon, 20);
  if (result.audit) {
    const inv = result.audit.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
    assert.ok(inv, 'the invariant is emitted when the gate is on');
    assert.equal(inv.pass, false);
    assert.ok(result.audit.failed_invariants.includes('forecast-data-sufficiency'));
  }
});
