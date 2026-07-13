import { test } from 'node:test';
import assert from 'node:assert/strict';

import { observeOpportunities } from '../oracle-watcher.js';
import { analyze } from '../analyzer.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

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

// A dip whose LAST few steps are a volatile burst — so the conditional (regime)
// vol going into the next tick sits well above the window-averaged realized vol.
const BURST_DIP = [10, 9.9, 9.85, 9.8, 9.2, 9.6, 8.9, 9.4];

test('analyzer: without regimeVol the risk vol is the realized vol (legacy, byte-identical)', () => {
  const r = readings({ ATOM: BURST_DIP });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50 } };
  const prices = { ATOM: r[r.length - 1].prices.ATOM };

  const base = analyze({ opportunities: opp, readings: r, portfolio, prices }, { scoreFloor: 0 });
  const s = base.scores.find((x) => x.asset === 'ATOM');
  assert.ok(s, 'ATOM scored');
  // No regime read → riskVol equals realized vol, and no conditional fields.
  assert.equal(s.riskVol, s.volatility);
  assert.equal(s.conditionalVol, null);
  assert.equal(s.persistence, null);
});

test('analyzer: a high-vol regime read discounts the score vs realized-vol-only', () => {
  const r = readings({ ATOM: BURST_DIP });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50 } };
  const prices = { ATOM: r[r.length - 1].prices.ATOM };

  const base = analyze({ opportunities: opp, readings: r, portfolio, prices }, { scoreFloor: 0 });
  const regimed = analyze(
    { opportunities: opp, readings: r, portfolio, prices },
    { scoreFloor: 0, regimeVol: { kind: 'garch', alpha: 0.2, beta: 0.75 }, regimeWeight: 1 },
  );

  const sb = base.scores.find((x) => x.asset === 'ATOM');
  const sr = regimed.scores.find((x) => x.asset === 'ATOM');
  assert.ok(sr.conditionalVol != null && sr.persistence != null, 'regime fields populated');
  // The recent burst lifts conditional vol above realized, so the risk
  // denominator grows and the (positive) buy score shrinks.
  assert.ok(sr.conditionalVol > sb.volatility, 'conditional vol > realized vol after a burst');
  assert.ok(sr.riskVol > sb.riskVol, 'regime risk vol exceeds the realized-only risk vol');
  assert.ok(Math.abs(sr.score) < Math.abs(sb.score),
    `regime discounts the score (|${sr.score}| < |${sb.score}|)`);
});

test('analyzer: regimeWeight blends conditional and realized vol', () => {
  const r = readings({ ATOM: BURST_DIP });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50 } };
  const prices = { ATOM: r[r.length - 1].prices.ATOM };

  const half = analyze(
    { opportunities: opp, readings: r, portfolio, prices },
    { scoreFloor: 0, regimeVol: { kind: 'garch', alpha: 0.2, beta: 0.75 }, regimeWeight: 0.5 },
  ).scores.find((x) => x.asset === 'ATOM');
  const full = analyze(
    { opportunities: opp, readings: r, portfolio, prices },
    { scoreFloor: 0, regimeVol: { kind: 'garch', alpha: 0.2, beta: 0.75 }, regimeWeight: 1 },
  ).scores.find((x) => x.asset === 'ATOM');

  // 0.5 blend sits strictly between realized (weight 0) and full conditional.
  const expectHalf = 0.5 * half.volatility + 0.5 * half.conditionalVol;
  assert.ok(Math.abs(half.riskVol - expectHalf) < 1e-12, 'half-weight blend is exact');
  assert.ok(half.riskVol < full.riskVol, 'more weight on the elevated conditional vol → higher risk vol');
});

test('ooda-cycle: analyzer inherits the forecaster adaptiveVol descriptor as its regimeVol', async () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'regime-thread',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 12; i += 1) sim.tick();

  const result = await runOodaCycle({
    world,
    history: sim.history,
    cycleId: 'regime-thread',
    config: {
      windowTicks: 12,
      oracle: { thresholdBps: 5 },
      analyzer: { scoreFloor: 0 },
      forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
      bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
      auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 13 },
    },
  });

  // The cycle must not touch a wallet, and where the analyzer acted its scores
  // carry the regime read threaded from the forecaster's descriptor.
  assert.equal(result.walletTouched, false);
  if (result.analysis && result.analysis.scores.length) {
    const scored = result.analysis.scores.find((s) => s.conditionalVol != null);
    assert.ok(scored, 'at least one score carries a threaded conditional-vol regime read');
  }
});
