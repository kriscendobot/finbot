import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slippageFill, gasCost } from '../costs.js';
import { sfc32 } from '../price-feed.js';

test('slippageFill: buys fill above mid, sells below', () => {
  const buy = slippageFill({ side: 'buy', price: 100, rng: sfc32(1) }, { jitterBps: 0 });
  const sell = slippageFill({ side: 'sell', price: 100, rng: sfc32(1) }, { jitterBps: 0 });
  assert.ok(buy > 100, 'buy adverse');
  assert.ok(sell < 100, 'sell adverse');
});

test('slippageFill: size impact widens the fill', () => {
  const small = slippageFill({ side: 'buy', price: 100, notional: 0, rng: sfc32(5) }, { jitterBps: 0, impactPerUnitNotional: 1 });
  const big = slippageFill({ side: 'buy', price: 100, notional: 100, rng: sfc32(5) }, { jitterBps: 0, impactPerUnitNotional: 1 });
  assert.ok(big > small, 'larger notional => worse fill');
});

test('slippageFill: deterministic given the same rng seed', () => {
  const a = slippageFill({ side: 'buy', price: 100, rng: sfc32(7) });
  const b = slippageFill({ side: 'buy', price: 100, rng: sfc32(7) });
  assert.equal(a, b);
});

test('slippageFill: never returns a negative price', () => {
  const v = slippageFill({ side: 'sell', price: 0.0001, rng: sfc32(3) }, { baseBps: 100000 });
  assert.ok(v >= 0);
});

test('gasCost: non-negative and deterministic', () => {
  const a = gasCost(sfc32(2), { mean: 1, jitter: 0.5 });
  const b = gasCost(sfc32(2), { mean: 1, jitter: 0.5 });
  assert.equal(a, b);
  assert.ok(a >= 0);
});

test('gasCost: clamps to zero when the draw goes negative', () => {
  // mean below jitter can produce a negative pre-clamp draw.
  for (let s = 0; s < 50; s += 1) {
    assert.ok(gasCost(sfc32(s), { mean: 0.1, jitter: 1 }) >= 0);
  }
});
