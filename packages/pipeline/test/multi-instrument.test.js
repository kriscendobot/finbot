import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

import { observeOpportunities, windowFromHistory } from '../oracle-watcher.js';
import { analyze, correlationLookup } from '../analyzer.js';
import { runOodaCycle } from '../ooda-cycle.js';

// A window of readings over a fixed price book per asset.
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

const DIP = [10, 9.8, 9.6, 9.4, 9.2, 9.0];
const FLAT = [11, 11, 11, 11, 11, 11];

// ---------- correlation lookup ----------

test('correlationLookup: pair spec, nested map, and matrix all resolve symmetrically', () => {
  const pair = correlationLookup({ 'A:B': 0.7 }, ['A', 'B']);
  assert.equal(pair('A', 'B'), 0.7);
  assert.equal(pair('B', 'A'), 0.7);
  assert.equal(pair('A', 'A'), 1);
  assert.equal(pair('A', 'C'), 0);

  const nested = correlationLookup({ A: { B: 0.4 } }, ['A', 'B']);
  assert.equal(nested('B', 'A'), 0.4);

  const matrix = correlationLookup([[1, 0.3], [0.3, 1]], ['A', 'B']);
  assert.equal(matrix('A', 'B'), 0.3);

  const none = correlationLookup(undefined, ['A', 'B']);
  assert.equal(none('A', 'B'), 0);
});

// ---------- APR-aware scoring ----------

test('analyzer: APR carry makes a non-deviating yield leg a candidate in multi mode', () => {
  const r = readings({ ATOM: DIP, sATOM: FLAT });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 50, sATOM: 50 } };
  const prices = { ATOM: 9, sATOM: 11 };
  const instruments = { ATOM: { type: 'growth' }, sATOM: { type: 'yield', apr: 0.5 } };

  // Single mode (legacy): the flat yield leg is never a candidate.
  const single = analyze({ opportunities: opp, readings: r, portfolio, prices, instruments }, { scoreFloor: 0 });
  assert.ok(!single.scores.some((s) => s.asset === 'sATOM'));

  // Multi mode: the yield leg enters on carry alone and scores positive.
  const multi = analyze(
    { opportunities: opp, readings: r, portfolio, prices, instruments },
    { scoreFloor: 0, maxPositions: 3, carryHorizonTicks: 40 },
  );
  const sa = multi.scores.find((s) => s.asset === 'sATOM');
  assert.ok(sa, 'yield leg is scored');
  assert.ok(sa.carry > 0, 'carry is positive');
  assert.ok(sa.score > 0, 'carry alone earns a positive score');
});

test('analyzer: a higher APR raises a yield leg score, all else equal', () => {
  const r = readings({ sATOM: FLAT });
  const portfolio = { cash: 1000, balances: { sATOM: 50 } };
  const prices = { sATOM: 11 };
  const lo = analyze(
    { opportunities: [], readings: r, portfolio, prices, instruments: { sATOM: { type: 'yield', apr: 0.05 } } },
    { scoreFloor: -1, maxPositions: 3, carryHorizonTicks: 40 },
  );
  const hi = analyze(
    { opportunities: [], readings: r, portfolio, prices, instruments: { sATOM: { type: 'yield', apr: 0.50 } } },
    { scoreFloor: -1, maxPositions: 3, carryHorizonTicks: 40 },
  );
  assert.ok(hi.scores[0].score > lo.scores[0].score);
});

// ---------- correlation-aware scoring ----------

test('analyzer: adding to a correlated cluster is penalized', () => {
  // A and B dip identically; the book already holds H. B is highly correlated
  // with H, A is not — so B should score below A purely on the cluster penalty.
  const r = readings({ A: DIP, B: DIP, H: FLAT.map(() => 10) });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30, assets: ['A', 'B'] }).crossings;
  const portfolio = { cash: 0, balances: { H: 100, A: 0, B: 0 } };
  const prices = { A: 9, B: 9, H: 10 };
  const correlations = { 'A:H': 0.0, 'B:H': 0.9 };
  const a = analyze(
    { opportunities: opp, readings: r, portfolio, prices, correlations },
    { scoreFloor: -1, maxPositions: 3, correlationPenalty: 0.5 },
  );
  const sa = a.scores.find((s) => s.asset === 'A');
  const sb = a.scores.find((s) => s.asset === 'B');
  assert.ok(Math.abs(sa.correlationPenalty) < 1e-9, 'uncorrelated leg pays no penalty');
  assert.ok(sb.correlationPenalty > 0.4, 'correlated leg pays the cluster penalty');
  assert.ok(sa.score > sb.score, 'the diversifying leg outscores the correlated one');
});

test('analyzer: with no correlation spec the penalty is zero (backward compatible)', () => {
  const r = readings({ ATOM: DIP });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 10 } };
  const a = analyze({ opportunities: opp, readings: r, portfolio, prices: { ATOM: 9 } }, { scoreFloor: 0 });
  assert.equal(a.next_action, 'propose-rebalance');
  assert.equal(a.scores[0].correlationPenalty, 0);
  assert.equal(a.scores[0].carry, 0);
  // Single-asset target weight, exactly as the legacy analyzer emitted.
  assert.deepEqual(Object.keys(a.targetWeights), ['ATOM']);
});

// ---------- multi-position allocation ----------

test('analyzer: multi mode spreads a bounded budget across several legs', () => {
  const r = readings({ ATOM: DIP, OSMO: DIP, sATOM: FLAT });
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 30, assets: ['ATOM', 'OSMO'] }).crossings;
  const portfolio = { cash: 4000, balances: { ATOM: 50, OSMO: 50, sATOM: 50 } };
  const prices = { ATOM: 9, OSMO: 9, sATOM: 11 };
  const instruments = { ATOM: { type: 'growth' }, OSMO: { type: 'growth' }, sATOM: { type: 'yield', apr: 0.4 } };

  const single = analyze({ opportunities: opp, readings: r, portfolio, prices, instruments }, { scoreFloor: 0 });
  assert.equal(Object.keys(single.targetWeights).length, 1);

  const multi = analyze(
    { opportunities: opp, readings: r, portfolio, prices, instruments },
    { scoreFloor: 0, maxPositions: 3, maxTotalWeight: 0.8, maxTargetWeight: 0.5, carryHorizonTicks: 40 },
  );
  const legs = Object.keys(multi.targetWeights);
  assert.ok(legs.length >= 2, `multi mode allocates across several legs (got ${legs})`);
  assert.ok(legs.includes('sATOM'), 'the yield leg earns a place on carry');
  const total = Object.values(multi.targetWeights).reduce((a, b) => a + b, 0);
  assert.ok(total <= 0.8 + 1e-9, 'the total risk budget is respected');
  for (const w of Object.values(multi.targetWeights)) assert.ok(w <= 0.5 + 1e-9, 'per-leg cap respected');
});

// ---------- end-to-end multi-instrument dry-run cycle ----------

function threeInstrumentWorld(seed) {
  // Deterministic replay: ATOM and OSMO dip in lockstep (correlated growth
  // legs), stATOM holds flat and accrues yield (the carry leg).
  const frames = [];
  for (let t = 0; t <= 11; t += 1) {
    const f = t / 11;
    frames.push({ ATOM: 10 - 1.0 * f, OSMO: 5 - 0.5 * f, stATOM: 11 });
  }
  return makeWorld({
    portfolio: { cash: 4000, balances: { ATOM: 100, OSMO: 100, stATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'replay', frames, wrap: false },
    instruments: {
      ATOM: { type: 'growth' },
      OSMO: { type: 'growth' },
      stATOM: { type: 'yield', apr: 0.15, accrualPeriod: 1, ticksPerYear: 365, reinvest: 'cash' },
    },
    seed,
  });
}

const multiConfig = {
  windowTicks: 10,
  oracle: { thresholdBps: 30 },
  correlations: { 'ATOM:OSMO': 0.9 },
  analyzer: { scoreFloor: 0, maxPositions: 3, maxTotalWeight: 0.8, maxTargetWeight: 0.5, carryHorizonTicks: 40, correlationPenalty: 0.5 },
  forecaster: { ensembleSize: 30, horizon: 10, baseSeed: 500 },
  bounds: { maxStepPct: 0.4, maxDayPct: 1.0, concentrationCapPct: 0.9 },
  auditor: { tailFloorPct: 0.4, stalenessWindowTicks: 12 },
};

test('OODA cycle: a >=3-instrument dry-run completes with a yield leg in the allocation', async () => {
  const world = threeInstrumentWorld(1);
  const sim = runSimulator(world);
  for (let i = 0; i < 10; i += 1) sim.tick();

  // Yield accrued over the warm-up ticks: 50 units * 11 * 0.15/365 per tick.
  const warm = world.portfolio.markToMarket(world.priceFeed.current());
  assert.ok(warm.accruedIncome > 0, 'the yield leg accrued during warm-up');

  const res = await runOodaCycle({ world, history: sim.history, config: multiConfig, cycleId: 'mi' });
  assert.equal(res.outcome, 'dry-run-complete', res.summary);

  const legs = Object.keys(res.analysis.targetWeights);
  assert.ok(legs.length >= 3, `allocation spans the instruments (got ${legs})`);
  assert.ok(legs.includes('stATOM'), 'the yield instrument is in the target allocation');

  // The proposal carries one step per moved leg, the audit approves, and the
  // wallet is never constructed in dry-run.
  assert.ok(res.proposal.steps.length >= 3);
  assert.equal(res.audit.verdict, 'approved', JSON.stringify(res.audit.failed_invariants));
  assert.equal(res.walletTouched, false);
});

test('OODA cycle: the multi-instrument cycle is deterministic', async () => {
  const a = threeInstrumentWorld(1);
  const b = threeInstrumentWorld(1);
  const sa = runSimulator(a);
  const sb = runSimulator(b);
  for (let i = 0; i < 10; i += 1) { sa.tick(); sb.tick(); }
  const ra = await runOodaCycle({ world: a, history: sa.history, config: multiConfig, cycleId: 'd' });
  const rb = await runOodaCycle({ world: b, history: sb.history, config: multiConfig, cycleId: 'd' });
  assert.equal(ra.proposal.proposal_hash, rb.proposal.proposal_hash);
  assert.deepEqual(ra.analysis.targetWeights, rb.analysis.targetWeights);
});
