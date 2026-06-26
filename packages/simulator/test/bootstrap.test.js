import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapQuantileBands, quantileSorted } from '../bootstrap.js';
import { sfc32, gaussian } from '../price-feed.js';

test('quantileSorted: nearest-rank on a sorted array', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantileSorted(s, 0), 1);
  assert.equal(quantileSorted(s, 0.5), 6);
  assert.equal(quantileSorted(s, 0.99), 10);
});

test('bootstrapQuantileBands: bands bracket the point estimate', () => {
  const values = [];
  for (let i = 0; i < 500; i += 1) values.push(Math.sin(i) * 10 + i * 0.1);
  const bands = bootstrapQuantileBands(values, { quantiles: [0.05, 0.5, 0.95], resamples: 300, seed: 1 });
  assert.equal(bands.length, 3);
  for (const band of bands) {
    assert.ok(band.lo <= band.point + 1e-9, `lo ${band.lo} <= point ${band.point}`);
    assert.ok(band.hi >= band.point - 1e-9, `hi ${band.hi} >= point ${band.point}`);
    assert.ok(band.stderr >= 0);
  }
});

test('bootstrapQuantileBands: tail quantiles are noisier than the median for a bell sample', () => {
  // A bell-shaped (Gaussian) sample has sparse tails, so the p99 order
  // statistic is estimated from far fewer effective observations than the
  // median — its bootstrap standard error is larger.
  const rng = sfc32(1234);
  const values = Array.from({ length: 600 }, () => gaussian(rng));
  const bands = bootstrapQuantileBands(values, { quantiles: [0.5, 0.99], resamples: 600, seed: 2 });
  const median = bands.find((b) => b.q === 0.5);
  const tail = bands.find((b) => b.q === 0.99);
  assert.ok(tail.stderr > median.stderr, `p99 stderr ${tail.stderr} should exceed median stderr ${median.stderr}`);
});

test('bootstrapQuantileBands: deterministic given the same seed', () => {
  const values = Array.from({ length: 200 }, (_, i) => i * 1.5 - 30);
  const a = bootstrapQuantileBands(values, { seed: 42 });
  const b = bootstrapQuantileBands(values, { seed: 42 });
  assert.deepEqual(a, b);
});

test('bootstrapQuantileBands: degenerate sizes do not throw', () => {
  assert.deepEqual(
    bootstrapQuantileBands([], { quantiles: [0.5] }).map((b) => b.q),
    [0.5],
  );
  const one = bootstrapQuantileBands([7], { quantiles: [0.5] });
  assert.equal(one[0].lo, 7);
  assert.equal(one[0].hi, 7);
});
