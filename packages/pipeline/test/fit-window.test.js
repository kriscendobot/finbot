import { test } from 'node:test';
import assert from 'node:assert/strict';

import { observeOpportunities } from '../oracle-watcher.js';
import { analyze } from '../analyzer.js';
import { project } from '../forecaster.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// The separable fit window: the oracle deviation and realized-vol reads use the
// short, recent `readings`, but the GARCH vol-surface fit reads a LONGER
// `fitReadings` so the per-instrument MLE (which needs >=12 returns) can engage
// on a live cycle whose deviation window is short. Both windows end at the same
// current tick.

// A window of readings from a per-asset price series.
function readings(seriesByAsset, startTick = 0) {
  const assets = Object.keys(seriesByAsset);
  const len = seriesByAsset[assets[0]].length;
  const out = [];
  for (let i = 0; i < len; i += 1) {
    const prices = {};
    for (const a of assets) prices[a] = seriesByAsset[a][i];
    out.push({ t: startTick + i, prices });
  }
  return out;
}

// A 16-frame dip (15 returns) whose vol clusters late — long enough that the
// full window clears the MLE's 12-return threshold while its last 10 frames (9
// returns) do not.
const LONG_DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];

test('analyzer: the regime fit reads fitReadings, not the short deviation window', () => {
  const long = readings({ ATOM: LONG_DIP });
  const short = long.slice(long.length - 10); // last 10 frames → 9 returns, below the MLE floor
  const opp = observeOpportunities({ readings: short }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50 } };
  const prices = { ATOM: short[short.length - 1].prices.ATOM };
  const mle = { kind: 'garch', estimate: 'mle' };

  // Fit reads the long window even though the deviation window is short.
  const withFit = analyze(
    { opportunities: opp, readings: short, fitReadings: long, portfolio, prices },
    { scoreFloor: 0, regimeVol: mle, regimeWeight: 1 },
  ).scores.find((s) => s.asset === 'ATOM');
  // Reference: fitting directly over the long window (readings === long).
  const longOnly = analyze(
    { opportunities: opp, readings: long, portfolio, prices },
    { scoreFloor: 0, regimeVol: mle, regimeWeight: 1 },
  ).scores.find((s) => s.asset === 'ATOM');
  // With no fitReadings, the regime fits over the short window → MLE falls back
  // to the fixed split (a different persistence).
  const shortOnly = analyze(
    { opportunities: opp, readings: short, portfolio, prices },
    { scoreFloor: 0, regimeVol: mle, regimeWeight: 1 },
  ).scores.find((s) => s.asset === 'ATOM');

  assert.ok(withFit.persistence != null, 'a regime read is present');
  // fitReadings drives the regime: withFit's persistence matches the long-window
  // fit, not the short-window fallback.
  assert.ok(Math.abs(withFit.persistence - longOnly.persistence) < 1e-12,
    'fitReadings fit === long-window fit');
  assert.ok(Math.abs(withFit.persistence - shortOnly.persistence) > 1e-9,
    'the short window (no fitReadings) falls back to a different persistence');
});

test('analyzer: fitReadings is used only for the regime; the realized-vol read stays on the short window', () => {
  const long = readings({ ATOM: LONG_DIP });
  const short = long.slice(long.length - 10);
  const opp = observeOpportunities({ readings: short }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50 } };
  const prices = { ATOM: short[short.length - 1].prices.ATOM };

  const withFit = analyze(
    { opportunities: opp, readings: short, fitReadings: long, portfolio, prices },
    { scoreFloor: 0, regimeVol: { kind: 'garch', estimate: 'mle' }, regimeWeight: 1 },
  ).scores.find((s) => s.asset === 'ATOM');
  const plain = analyze(
    { opportunities: opp, readings: short, portfolio, prices },
    { scoreFloor: 0 },
  ).scores.find((s) => s.asset === 'ATOM');

  // realized vol comes from the SHORT window in both, so it is unchanged by the
  // longer fit window.
  assert.equal(withFit.volatility, plain.volatility);
});

test('analyzer: a fitReadings no longer than readings is ignored (byte-identical)', () => {
  const short = readings({ ATOM: LONG_DIP.slice(LONG_DIP.length - 10) });
  const opp = observeOpportunities({ readings: short }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50 } };
  const prices = { ATOM: short[short.length - 1].prices.ATOM };
  const cfg = { scoreFloor: 0, regimeVol: { kind: 'garch' }, regimeWeight: 0.5 };

  const withEqual = analyze({ opportunities: opp, readings: short, fitReadings: short, portfolio, prices }, cfg);
  const without = analyze({ opportunities: opp, readings: short, portfolio, prices }, cfg);
  assert.deepEqual(withEqual, without);
});

test('forecaster: the adaptive vol fit reads fitReadings when longer', () => {
  const long = readings({ ATOM: LONG_DIP });
  const short = long.slice(long.length - 10);
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: short[short.length - 1].prices.ATOM }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'fit-window-forecaster',
  });
  const cfg = { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, adaptiveVol: { kind: 'garch', estimate: 'mle' } };

  const withFit = project({ world, targetWeights: { ATOM: 0.5 }, readings: short, fitReadings: long }, cfg);
  const shortOnly = project({ world, targetWeights: { ATOM: 0.5 }, readings: short }, cfg);

  // The fit sees the whole long window; the short-only fit sees just 10 frames.
  assert.equal(withFit.volFit.frames, long.length);
  assert.equal(shortOnly.volFit.frames, short.length);
});

test('ooda-cycle: config.fitWindowTicks derives a longer fit window, engaging the live MLE', async () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'fit-window-ooda',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 16; i += 1) sim.tick();

  const result = await runOodaCycle({
    world,
    history: sim.history,
    cycleId: 'fit-window-ooda',
    config: {
      windowTicks: 10,          // short oracle / realized-vol window (9 returns)
      fitWindowTicks: 16,       // longer vol-fit window (15 returns → MLE engages)
      oracle: { thresholdBps: 5 },
      analyzer: { scoreFloor: 0 },
      forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100, adaptiveVol: { kind: 'garch', estimate: 'mle' } },
      bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
      auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11 },
    },
  });

  assert.equal(result.walletTouched, false);
  if (result.forecast) {
    assert.equal(result.forecast.volFit.frames, 16, 'the fit read the 16-frame window, not the 10-frame oracle window');
  }
});

test('ooda-cycle: fitWindowTicks <= windowTicks is byte-identical to omitting it', async () => {
  const build = () => {
    const world = makeWorld({
      portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
      priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
      seed: 7,
      tag: 'fit-window-identity',
    });
    const sim = runSimulator(world);
    for (let i = 0; i < 12; i += 1) sim.tick();
    return { world, history: sim.history };
  };
  const baseConfig = {
    windowTicks: 12,
    oracle: { thresholdBps: 5 },
    analyzer: { scoreFloor: 0 },
    forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
    bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
    auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 13 },
  };

  const a = build();
  const withoutFit = await runOodaCycle({ world: a.world, history: a.history, cycleId: 'id', config: baseConfig });
  const b = build();
  const withShortFit = await runOodaCycle({
    world: b.world, history: b.history, cycleId: 'id',
    config: { ...baseConfig, fitWindowTicks: 10 }, // <= windowTicks → ignored
  });

  assert.deepEqual(withShortFit, withoutFit);
});
