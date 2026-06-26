import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VolatilitySurface, surfaceFromPriceHistory } from '../vol-surface.js';
import { GBMPriceFeed, sfc32 } from '../price-feed.js';

test('VolatilitySurface: sample draws from the empirical set and respects the floor', () => {
  const surf = new VolatilitySurface({ A: [0.01, 0.05, 0.1] }, { floor: 0.02 });
  const rng = sfc32(1);
  for (let i = 0; i < 100; i += 1) {
    const v = surf.sample('A', rng);
    assert.ok(v >= 0.02, 'floor applied');
    assert.ok([0.02, 0.05, 0.1].includes(v), 'value comes from the (floored) sample set');
  }
});

test('VolatilitySurface: stats reports mean / min / max / count', () => {
  const surf = new VolatilitySurface({ A: [0.1, 0.2, 0.3] });
  const s = surf.stats('A');
  assert.equal(s.count, 3);
  assert.equal(s.min, 0.1);
  assert.equal(s.max, 0.3);
  assert.ok(Math.abs(s.mean - 0.2) < 1e-12);
});

test('VolatilitySurface: unknown asset throws', () => {
  const surf = new VolatilitySurface({ A: [0.1] });
  assert.equal(surf.has('B'), false);
  assert.throws(() => surf.sample('B', sfc32(1)), /no samples/);
});

test('VolatilitySurface: empty / malformed input throws', () => {
  assert.throws(() => new VolatilitySurface(null), /samples must be/);
  assert.throws(() => new VolatilitySurface({ A: [] }), /non-empty/);
});

test('surfaceFromPriceHistory: derives rolling realized vols', () => {
  const frames = [];
  let p = 100;
  const rng = sfc32(42);
  for (let i = 0; i < 60; i += 1) {
    p *= Math.exp((rng() - 0.5) * 0.04);
    frames.push({ A: p });
  }
  const surf = surfaceFromPriceHistory(frames, { window: 20 });
  assert.ok(surf.has('A'));
  const s = surf.stats('A');
  assert.ok(s.count > 0);
  assert.ok(s.mean > 0, 'realized vol is positive');
});

test('GBM with a vol surface: deterministic and reproducible', () => {
  const surf = new VolatilitySurface({ A: [0.02, 0.05, 0.1, 0.15] });
  const make = () => new GBMPriceFeed({
    initialPrices: { A: 100 },
    seed: 9,
    volSurface: surf,
  });
  const a = make();
  const b = make();
  for (let i = 0; i < 50; i += 1) assert.deepEqual(a.tick(), b.tick());
});

test('GBM with a vol surface: widens the terminal spread vs a fixed low vol', () => {
  // A surface that mixes in high-vol draws should, over many independent
  // walks, produce a wider terminal-price spread than a fixed low vol.
  const surf = new VolatilitySurface({ A: [0.02, 0.25] });
  const terminal = (feedFactory) => {
    const xs = [];
    for (let s = 0; s < 200; s += 1) {
      const feed = feedFactory(s);
      let last = feed.current().A;
      for (let i = 0; i < 30; i += 1) last = feed.tick().A;
      xs.push(last);
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(variance);
  };
  const fixedStd = terminal((s) => new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 1000 + s }));
  const surfStd = terminal((s) => new GBMPriceFeed({ initialPrices: { A: 100 }, seed: 1000 + s, volSurface: surf }));
  assert.ok(surfStd > fixedStd, `surface std ${surfStd} should exceed fixed-low-vol std ${fixedStd}`);
});
