import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  project,
  projectionArtifact,
  regimeHorizon,
  worstAssetPersistence,
  persistenceStress,
} from '../forecaster.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// The regime-aware forecaster horizon: the forecast's per-instrument GARCH
// persistence (α+β) stretches the projection horizon. A highly persistent regime
// holds its elevated conditional variance for many ticks, so a shock this cycle
// compounds rather than mean-reverting away inside a short window — projecting
// LONGER lets the drawdown-and-recovery dynamics the auditor's pathStats read
// out resolve instead of truncating mid-shock. The companion of the
// regime-tail-floor: measure-the-regime, then let-the-regime-decide, here on
// projection depth rather than the audit gate.

// A 16-frame series whose vol clusters late; its plain-GARCH fit pins the fixed
// 0.08 / 0.90 split → persistence exactly 0.98 (deterministic, no MLE needed).
const DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];

function readingsOf(series) {
  return series.map((p, i) => ({ t: i, prices: { ATOM: p } }));
}

test('worstAssetPersistence: keys off the max-persistence asset; inert without usable fit', () => {
  assert.deepEqual(worstAssetPersistence(null), { worstAsset: null, persistence: 0 });
  assert.deepEqual(worstAssetPersistence({}), { worstAsset: null, persistence: 0 });
  assert.deepEqual(
    worstAssetPersistence({ assets: { A: { persistence: NaN }, B: {} } }),
    { worstAsset: null, persistence: 0 },
  );
  assert.deepEqual(
    worstAssetPersistence({ assets: { A: { persistence: 0.5 }, B: { persistence: 0.9 }, C: { persistence: 0.7 } } }),
    { worstAsset: 'B', persistence: 0.9 },
  );
});

test('persistenceStress: clamped linear ramp; degenerate span is a step at hi', () => {
  assert.equal(persistenceStress(0.7, 0.7, 0.98), 0); // at lo → 0
  assert.equal(persistenceStress(0.98, 0.7, 0.98), 1); // at hi → 1
  assert.equal(persistenceStress(0.6, 0.7, 0.98), 0); // below lo clamps to 0
  assert.equal(persistenceStress(1.2, 0.7, 0.98), 1); // above hi clamps to 1
  assert.ok(Math.abs(persistenceStress(0.84, 0.7, 0.98) - 0.5) < 1e-9); // midpoint
  assert.equal(persistenceStress(0.99, 0.9, 0.9), 1); // degenerate span, at/above hi
  assert.equal(persistenceStress(0.8, 0.9, 0.9), 0); // degenerate span, below hi
});

test('regimeHorizon: off / inert / calm all leave the base horizon and null regime', () => {
  const volFit = { assets: { ATOM: { persistence: 0.98 } } };
  const knobs = { baseHorizon: 20, lo: 0.7, hi: 0.98, cap: 60 };
  // stretch 0 (off)
  assert.deepEqual(regimeHorizon({ ...knobs, volFit, stretch: 0 }), { horizon: 20, regime: null });
  // no volFit (plain forecast)
  assert.deepEqual(regimeHorizon({ ...knobs, volFit: null, stretch: 0.5 }), { horizon: 20, regime: null });
  // calm regime below lo → stress 0 → no stretch
  assert.deepEqual(
    regimeHorizon({ ...knobs, volFit: { assets: { ATOM: { persistence: 0.6 } } }, stretch: 0.5 }),
    { horizon: 20, regime: null },
  );
});

test('regimeHorizon: a persistent regime stretches the horizon and cites the worst asset', () => {
  const volFit = { assets: { ATOM: { persistence: 0.84 }, OSMO: { persistence: 0.98 } } };
  // stress(0.98) = 1.0 → round(20 * (1 + 0.5·1)) = 30, keyed off OSMO (the worst).
  const out = regimeHorizon({ baseHorizon: 20, volFit, stretch: 0.5, lo: 0.7, hi: 0.98, cap: 60 });
  assert.equal(out.horizon, 30);
  assert.deepEqual(out.regime, { baseHorizon: 20, persistence: 0.98, worstAsset: 'OSMO', stress: 1 });
});

test('regimeHorizon: the stretched horizon is bounded by the cap', () => {
  const volFit = { assets: { ATOM: { persistence: 0.98 } } };
  // round(20 * 1.5) = 30 but cap 25 clips it, and the cited baseHorizon is unchanged.
  const out = regimeHorizon({ baseHorizon: 20, volFit, stretch: 0.5, lo: 0.7, hi: 0.98, cap: 25 });
  assert.equal(out.horizon, 25);
  assert.equal(out.regime.baseHorizon, 20);
});

test('regimeHorizon: a stretch too small to change the rounded horizon stays inert', () => {
  const volFit = { assets: { ATOM: { persistence: 0.98 } } };
  // round(20 * (1 + 0.02·1)) = round(20.4) = 20 → no change → null regime.
  assert.deepEqual(
    regimeHorizon({ baseHorizon: 20, volFit, stretch: 0.02, lo: 0.7, hi: 0.98, cap: 60 }),
    { horizon: 20, regime: null },
  );
});

test('project: a persistent-regime fit stretches the horizon; off is byte-identical', () => {
  const window = readingsOf(DIP);
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: DIP[DIP.length - 1] },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: DIP[DIP.length - 1] }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'regime-horizon',
  });
  const base = {
    world, targetWeights: { ATOM: 0.5 }, readings: window,
  };
  const common = { ensembleSize: 8, horizon: 10, baseSeed: 100, render: false, adaptiveVol: { kind: 'garch' } };

  // Off (stretch 0, the current default): horizon stays 10, no horizonRegime.
  const off = project(base, { ...common, regimeHorizonStretch: 0 });
  assert.equal(off.volFit.assets.ATOM.persistence, 0.98);
  assert.equal(off.horizon, 10);
  assert.equal(off.horizonRegime, null);
  assert.equal(projectionArtifact(off).horizonRegime, undefined);

  // On: persistence 0.98 → stress 1.0 → round(10 * 1.5) = 15, cited.
  const on = project(base, { ...common, regimeHorizonStretch: 0.5 });
  assert.equal(on.horizon, 15);
  assert.deepEqual(on.horizonRegime, { baseHorizon: 10, persistence: 0.98, worstAsset: 'ATOM', stress: 1 });
  assert.deepEqual(projectionArtifact(on).horizonRegime, on.horizonRegime);
  // A longer horizon is a genuinely different projection (distinct terminal dist).
  assert.notEqual(on.summary.p05, off.summary.p05);

  // Determinism: same config → byte-identical artifact JSON.
  const on2 = project(base, { ...common, regimeHorizonStretch: 0.5 });
  assert.equal(JSON.stringify(projectionArtifact(on)), JSON.stringify(projectionArtifact(on2)));
});

test('ooda-cycle: adaptive vol on defaults the regime horizon stretch (0.5); off leaves it fixed', async () => {
  const buildWorld = (tag) => makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag,
  });
  const run = async (world, forecaster) => {
    const sim = runSimulator(world);
    for (let i = 0; i < 16; i += 1) sim.tick();
    return runOodaCycle({
      world,
      history: sim.history,
      cycleId: 'regime-horizon-ooda',
      config: {
        windowTicks: 10,
        fitWindowTicks: 16,
        oracle: { thresholdBps: 5 },
        analyzer: { scoreFloor: 0 },
        forecaster,
        bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
        auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11 },
      },
    });
  };

  // Adaptive on → the ooda-cycle defaults regimeHorizonStretch to 0.5; the fit's
  // persistence 0.98 → stress 1.0 → round(10 * 1.5) = 15.
  const on = await run(buildWorld('rh-on'), { ensembleSize: 8, horizon: 10, baseSeed: 100, adaptiveVol: { kind: 'garch' } });
  assert.equal(on.walletTouched, false);
  if (on.forecast) {
    assert.equal(on.forecast.horizon, 15);
    assert.equal(on.forecast.horizonRegime.worstAsset, 'ATOM');
  }

  // Adaptive off → no stretch, horizon stays at the configured 10.
  const off = await run(buildWorld('rh-off'), { ensembleSize: 8, horizon: 10, baseSeed: 100 });
  assert.equal(off.walletTouched, false);
  if (off.forecast) {
    assert.equal(off.forecast.horizon, 10);
    assert.equal(off.forecast.horizonRegime, null);
  }
});
