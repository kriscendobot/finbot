import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { project } from '../forecaster.js';

function world(seed) {
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0.001 }, seed },
    seed,
  });
}

test('forecaster: produces a histogram and quantiles', () => {
  const f = project(
    { world: world(7), targetWeights: { ATOM: 0.3 }, bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 } },
    { ensembleSize: 50, horizon: 10, baseSeed: 100 },
  );
  assert.equal(f.ensembleSize, 50);
  assert.equal(f.horizon, 10);
  assert.ok(f.histogram.counts.reduce((a, b) => a + b, 0) === 50);
  assert.ok(f.summary.p05 <= f.summary.p50);
  assert.ok(f.summary.p50 <= f.summary.p95);
  assert.ok(f.pProfit >= 0 && f.pProfit <= 1);
  assert.ok(f.actionSteps.length >= 1, 'a rebalance toward 30% should derive at least one step');
});

test('forecaster: deterministic given identical inputs (same seed schedule)', () => {
  const a = project(
    { world: world(7), targetWeights: { ATOM: 0.3 }, bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 } },
    { ensembleSize: 40, horizon: 8, baseSeed: 100 },
  );
  const b = project(
    { world: world(7), targetWeights: { ATOM: 0.3 }, bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 } },
    { ensembleSize: 40, horizon: 8, baseSeed: 100 },
  );
  assert.deepEqual(a.histogram.counts, b.histogram.counts);
  assert.equal(a.summary.p05, b.summary.p05);
  assert.equal(a.summary.meanEquity, b.summary.meanEquity);
});
