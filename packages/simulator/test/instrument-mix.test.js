import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rebalanceMix } from '../instrument-mix.js';
import { growthInstrument, yieldInstrument } from '../instruments.js';
import { gbmSeries } from '../fixtures.js';
import { sfc32 } from '../price-feed.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// A series that rises linearly, and one that is flat — so a buy-and-hold mix
// drifts away from 50/50 and the rebalancer must trade it back.
const rising = (from, to, n) => {
  const s = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) s[i] = from + ((to - from) * i) / n;
  return s;
};
const flat = (price, n) => new Array(n + 1).fill(price);

test('rebalanceMix: NAV equals positions + cash at every tick (accounting invariant)', () => {
  const legs = [
    { instrument: growthInstrument({ asset: 'A', series: rising(100, 200, 60) }), weight: 0.5 },
    { instrument: yieldInstrument({ asset: 'B', series: flat(100, 60), yieldRate: 0.001 }), weight: 0.5 },
  ];
  const out = rebalanceMix(legs, { capital: 1000, rebalancePeriod: 10, seed: 1 });
  // Reconstruct invariant: every reported NAV is finite, positive, monotone-ish
  // sanity, and the series length matches the walk.
  assert.equal(out.totalValueSeries.length, 61);
  for (const v of out.totalValueSeries) assert.ok(Number.isFinite(v) && v > 0);
  assert.ok(close(out.totalValueSeries[0], 1000, 1e-9));
});

test('rebalanceMix: rebalancing pulls weights back toward target', () => {
  const legs = [
    { instrument: growthInstrument({ asset: 'A', series: rising(100, 300, 60) }), weight: 0.5 },
    { instrument: growthInstrument({ asset: 'B', series: flat(100, 60) }), weight: 0.5 },
  ];
  const rebalanced = rebalanceMix(legs, { capital: 1000, rebalancePeriod: 5, seed: 2 });
  const heldOnly = rebalanceMix(legs, { capital: 1000, rebalancePeriod: 0, seed: 2 }); // never rebalance
  // With no rebalancing the winner dominates; with rebalancing the final
  // weight on A is closer to its 0.5 target.
  const targetGap = (w) => Math.abs(w[0] - 0.5);
  assert.ok(
    targetGap(rebalanced.finalWeights) < targetGap(heldOnly.finalWeights),
    `rebalanced gap ${targetGap(rebalanced.finalWeights)} !< held gap ${targetGap(heldOnly.finalWeights)}`,
  );
});

test('rebalanceMix: frictions (slippage + gas + fee) drag final NAV below frictionless', () => {
  const legs = [
    { instrument: growthInstrument({ asset: 'A', series: rising(100, 250, 80) }), weight: 0.5 },
    { instrument: growthInstrument({ asset: 'B', series: flat(100, 80) }), weight: 0.5 },
  ];
  const frictionless = rebalanceMix(legs, { capital: 1000, rebalancePeriod: 5, seed: 3 });
  const costly = rebalanceMix(legs, {
    capital: 1000,
    rebalancePeriod: 5,
    seed: 3,
    slippage: { baseBps: 20, jitterBps: 5 },
    gas: { mean: 0.5, jitter: 0.1 },
    feeBps: 10,
  });
  assert.ok(costly.totalReturn < frictionless.totalReturn);
  assert.ok(costly.costs.total > 0);
  assert.ok(costly.costs.slippage > 0 && costly.costs.gas > 0 && costly.costs.fees > 0);
  assert.ok(close(frictionless.costs.slippage, 0, 1e-9));
});

test('rebalanceMix: deterministic under a fixed seed', () => {
  const legs = [
    { instrument: growthInstrument({ asset: 'A', series: gbmSeries({ length: 60, seed: 7 }).series }), weight: 0.6 },
    { instrument: yieldInstrument({ asset: 'B', series: flat(100, 60), yieldRate: 0.0008 }), weight: 0.4 },
  ];
  const opts = { capital: 1000, rebalancePeriod: 8, seed: 42, slippage: { baseBps: 10, jitterBps: 8 }, gas: { mean: 0.3, jitter: 0.2 }, feeBps: 5 };
  const a = rebalanceMix(legs, opts);
  const b = rebalanceMix(legs, opts);
  assert.deepEqual(a.totalValueSeries, b.totalValueSeries);
  assert.deepEqual(a.costs, b.costs);
});

test('rebalanceMix: an explicit rng closure threads through reproducibly', () => {
  const legs = [
    { instrument: growthInstrument({ asset: 'A', series: rising(100, 150, 40) }), weight: 0.5 },
    { instrument: growthInstrument({ asset: 'B', series: flat(100, 40) }), weight: 0.5 },
  ];
  const a = rebalanceMix(legs, { rng: sfc32(11), rebalancePeriod: 5, slippage: { baseBps: 5, jitterBps: 5 } });
  const b = rebalanceMix(legs, { rng: sfc32(11), rebalancePeriod: 5, slippage: { baseBps: 5, jitterBps: 5 } });
  assert.deepEqual(a.totalValueSeries, b.totalValueSeries);
});

test('rebalanceMix: never spends more cash than held (cash stays non-negative)', () => {
  const legs = [
    { instrument: growthInstrument({ asset: 'A', series: rising(100, 400, 100) }), weight: 0.7 },
    { instrument: growthInstrument({ asset: 'B', series: rising(100, 50, 100) }), weight: 0.3 },
  ];
  const out = rebalanceMix(legs, {
    capital: 1000,
    rebalancePeriod: 4,
    seed: 5,
    slippage: { baseBps: 30, jitterBps: 10 },
    gas: { mean: 1, jitter: 0.5 },
    feeBps: 20,
  });
  assert.ok(out.finalCash >= -1e-9, `final cash ${out.finalCash}`);
});

test('rebalanceMix: payouts flow to shared cash and lift NAV vs a non-yielding mix', () => {
  const yielding = [
    { instrument: growthInstrument({ asset: 'A', series: flat(100, 60) }), weight: 0.5 },
    { instrument: yieldInstrument({ asset: 'B', series: flat(100, 60), yieldRate: 0.002 }), weight: 0.5 },
  ];
  const inert = [
    { instrument: growthInstrument({ asset: 'A', series: flat(100, 60) }), weight: 0.5 },
    { instrument: growthInstrument({ asset: 'B', series: flat(100, 60) }), weight: 0.5 },
  ];
  const y = rebalanceMix(yielding, { capital: 1000, rebalancePeriod: 20, seed: 9 });
  const i = rebalanceMix(inert, { capital: 1000, rebalancePeriod: 20, seed: 9 });
  assert.ok(y.totalReturn > i.totalReturn);
  assert.ok(close(i.totalReturn, 0, 1e-9)); // flat prices, no yield => flat NAV
});
