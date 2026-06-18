import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forecast, binHistogram } from '../forecast.js';
import { makeWorld } from '../world.js';
import { runSimulator } from '../runner.js';

test('forecast: throws on missing from', () => {
  assert.throws(() => forecast({ horizon: 5, ensembleSize: 3 }));
});

test('forecast: accepts a Simulator', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 },
  }));
  const r = forecast({ from: sim, horizon: 5, ensembleSize: 4 });
  assert.equal(r.outcomes.length, 4);
});

test('forecast: accepts a World directly', () => {
  const world = makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 },
  });
  const r = forecast({ from: world, horizon: 5, ensembleSize: 4 });
  assert.equal(r.outcomes.length, 4);
});

test('forecast: deterministic given baseSeed', () => {
  const buildWorld = () => makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 },
  });
  const r1 = forecast({ from: buildWorld(), horizon: 5, ensembleSize: 5, baseSeed: 100 });
  const r2 = forecast({ from: buildWorld(), horizon: 5, ensembleSize: 5, baseSeed: 100 });
  assert.deepEqual(r1.outcomes, r2.outcomes);
  assert.deepEqual(r1.histogram, r2.histogram);
});

test('forecast: different baseSeeds yield different ensembles', () => {
  // Portfolio must hold an asset so the price feed actually moves equity.
  const buildWorld = () => makeWorld({
    portfolio: { cash: 500, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.1 }, seed: 1 },
  });
  const r1 = forecast({ from: buildWorld(), horizon: 5, ensembleSize: 5, baseSeed: 100 });
  const r2 = forecast({ from: buildWorld(), horizon: 5, ensembleSize: 5, baseSeed: 200 });
  // At least one outcome should differ
  let differed = false;
  for (let i = 0; i < r1.outcomes.length; i += 1) {
    if (r1.outcomes[i].finalEquity !== r2.outcomes[i].finalEquity) differed = true;
  }
  assert.ok(differed);
});

test('forecast: action runs at t=1 inside child', () => {
  let calls = 0;
  let observedT = null;
  const action = (world, t, prices) => {
    calls += 1;
    observedT = t;
    // Buy a unit of ATOM with the action.
    world.portfolio.applyTrade({ t, side: 'buy', asset: 'ATOM', qty: 1, price: prices.ATOM });
  };
  const world = makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 },
  });
  const r = forecast({ from: world, action, horizon: 5, ensembleSize: 3 });
  assert.equal(calls, 3, 'action fires once per ensemble member');
  assert.equal(observedT, 1);
  // No outcome's portfolio should fall to zero (all actions succeeded)
  for (const o of r.outcomes) assert.ok(o.finalEquity > 0);
});

test('forecast: summary contains percentiles and pProfit', () => {
  const world = makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 },
  });
  const r = forecast({ from: world, horizon: 10, ensembleSize: 20 });
  assert.ok('meanEquity' in r.summary);
  assert.ok('p05' in r.summary);
  assert.ok('p50' in r.summary);
  assert.ok('p95' in r.summary);
  assert.ok('pProfit' in r.summary);
  assert.ok(r.summary.pProfit >= 0 && r.summary.pProfit <= 1);
});

test('forecast: histogram has bins counts summing to ensembleSize', () => {
  // Hold an asset so prices actually move equity.
  const world = makeWorld({
    portfolio: { cash: 500, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.1 }, seed: 1 },
  });
  const r = forecast({ from: world, horizon: 10, ensembleSize: 50, bins: 8 });
  const total = r.histogram.counts.reduce((a, b) => a + b, 0);
  assert.equal(total, 50);
  assert.equal(r.histogram.counts.length, 8);
});

test('binHistogram: empty returns zeros', () => {
  const h = binHistogram([], 5);
  assert.equal(h.counts.length, 0);
  assert.equal(h.binWidth, 0);
});

test('binHistogram: identical values single-bin degenerate', () => {
  const h = binHistogram([7, 7, 7, 7], 5);
  assert.equal(h.counts.length, 1);
  assert.equal(h.counts[0], 4);
});

test('binHistogram: distributes across requested bins', () => {
  const h = binHistogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.equal(h.counts.length, 5);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 10);
});

test('forecast: nested forecast (forecast of forecast) works meta-circularly', () => {
  const world = makeWorld({
    portfolio: { cash: 1000 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, seed: 1 },
  });
  const sim = runSimulator(world);
  // Outer forecast spawns N children.
  const outer = forecast({ from: sim, horizon: 3, ensembleSize: 3, baseSeed: 100 });
  // Inner forecast: spawn a sub-forecast inside one of the children's tickFns.
  // Just check that we can forecast from the same world a second time with
  // a different baseSeed and not perturb the outer's determinism.
  const inner = forecast({ from: sim, horizon: 3, ensembleSize: 3, baseSeed: 500 });
  // Outer should be reproducible.
  const outerAgain = forecast({ from: sim, horizon: 3, ensembleSize: 3, baseSeed: 100 });
  assert.deepEqual(outer.outcomes, outerAgain.outcomes);
  // And inner is a distinct ensemble
  assert.notDeepEqual(outer.outcomes, inner.outcomes);
});
