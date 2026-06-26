import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cyclicSeries,
  gbmSeries,
  synthesisSeries,
  blockBootstrapSeries,
  seriesLogReturns,
  seriesToFrames,
} from '../fixtures.js';

function moments(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / n;
  return { mean, variance };
}

// --- GBM ---

test('gbmSeries: deterministic for same seed', () => {
  const a = gbmSeries({ seed: 5, length: 100 }).series;
  const b = gbmSeries({ seed: 5, length: 100 }).series;
  assert.deepEqual(a, b);
});

test('gbmSeries: different seeds diverge', () => {
  const a = gbmSeries({ seed: 1, length: 50 }).series;
  const b = gbmSeries({ seed: 2, length: 50 }).series;
  let differed = false;
  for (let i = 1; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 1e-9) differed = true;
  assert.ok(differed);
});

test('gbmSeries: recovers log-return mean and variance', () => {
  const mu = 0.001;
  const sigma = 0.03;
  const { series, meta } = gbmSeries({ initialPrice: 100, mu, sigma, length: 60000, seed: 7 });
  const { mean, variance } = moments(seriesLogReturns(series));
  // The known per-step moments live on meta.
  assert.ok(Math.abs(mean - meta.logReturnMean) < 5e-4, `mean ${mean} vs ${meta.logReturnMean}`);
  assert.ok(Math.abs(variance - meta.logReturnVariance) < 5e-5, `var ${variance} vs ${meta.logReturnVariance}`);
  // And those equal the analytic GBM moments.
  assert.ok(Math.abs(meta.logReturnMean - (mu - 0.5 * sigma * sigma)) < 1e-12);
  assert.ok(Math.abs(meta.logReturnVariance - sigma * sigma) < 1e-12);
});

test('gbmSeries: series length is length+1 with initial anchor', () => {
  const { series } = gbmSeries({ initialPrice: 50, length: 10 });
  assert.equal(series.length, 11);
  assert.equal(series[0], 50);
});

// --- Cyclic ---

test('cyclicSeries: deterministic and noise-free is pure in t', () => {
  const a = cyclicSeries({ seed: 1, length: 100 }).series;
  const b = cyclicSeries({ seed: 999, length: 100 }).series; // seed irrelevant when noiseSigma=0
  assert.deepEqual(a, b);
});

test('cyclicSeries: amplitude bounds and period', () => {
  const initialPrice = 100;
  const amplitude = 0.15;
  const period = 40;
  const { series } = cyclicSeries({
    initialPrice, amplitude, frequency: 1 / period, phase: 0, length: 4 * period,
  });
  const max = Math.max(...series);
  const min = Math.min(...series);
  assert.ok(Math.abs(max - initialPrice * (1 + amplitude)) < 0.5, `max ${max}`);
  assert.ok(Math.abs(min - initialPrice * (1 - amplitude)) < 0.5, `min ${min}`);
  // One full period returns to (approximately) the starting level.
  assert.ok(Math.abs(series[period] - series[0]) < 1e-6, `period wrap ${series[period]} vs ${series[0]}`);
});

test('cyclicSeries: drift lifts the trend', () => {
  const flat = cyclicSeries({ drift: 0, length: 200, amplitude: 0.05 }).series;
  const rising = cyclicSeries({ drift: 0.002, length: 200, amplitude: 0.05 }).series;
  assert.ok(rising[200] > flat[200]);
});

// --- Synthesis ---

test('synthesisSeries: deterministic for same seed', () => {
  const a = synthesisSeries({ seed: 3, length: 128 }).series;
  const b = synthesisSeries({ seed: 3, length: 128 }).series;
  assert.deepEqual(a, b);
});

test('synthesisSeries: zero-amplitude cycles reduce to the scaled GBM trend', () => {
  const seed = 8;
  const length = 200;
  const initialPrice = 100;
  const gbm = { mu: 0.0005, sigma: 0.02 };
  const synth = synthesisSeries({
    initialPrice, gbm, cycles: [{ frequency: 1 / 10, amplitude: 0 }], length, seed,
  }).series;
  const trend = gbmSeries({ initialPrice: 1, ...gbm, length, seed }).series;
  for (let i = 0; i <= length; i += 1) {
    assert.ok(Math.abs(synth[i] - initialPrice * trend[i]) < 1e-9);
  }
});

test('synthesisSeries: higher sigma widens dispersion of terminal price', () => {
  const term = (sigma) => {
    const finals = [];
    for (let s = 0; s < 40; s += 1) {
      const { series } = synthesisSeries({ gbm: { mu: 0, sigma }, cycles: [], length: 128, seed: s });
      finals.push(series[series.length - 1]);
    }
    return moments(finals).variance;
  };
  assert.ok(term(0.04) > term(0.01));
});

// --- Block bootstrap (historical-data-driven) ---

test('blockBootstrapSeries: respects length and reseeds independently', () => {
  const historical = gbmSeries({ mu: 0.0008, sigma: 0.02, length: 500, seed: 1 }).series;
  const a = blockBootstrapSeries({ historical, length: 100, seed: 1 }).series;
  const b = blockBootstrapSeries({ historical, length: 100, seed: 2 }).series;
  assert.equal(a.length, 101);
  let differed = false;
  for (let i = 1; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 1e-9) differed = true;
  assert.ok(differed);
});

test('blockBootstrapSeries: preserves the historical drift in expectation', () => {
  const historical = gbmSeries({ mu: 0.001, sigma: 0.015, length: 4000, seed: 4 }).series;
  const histMean = moments(seriesLogReturns(historical)).mean;
  // Average log-return mean across many bootstrap realizations ~ historical mean.
  let acc = 0;
  const R = 60;
  for (let s = 0; s < R; s += 1) {
    const { series } = blockBootstrapSeries({ historical, length: 400, seed: 1000 + s });
    acc += moments(seriesLogReturns(series)).mean;
  }
  const bootMean = acc / R;
  assert.ok(Math.abs(bootMean - histMean) < 2e-4, `boot ${bootMean} vs hist ${histMean}`);
});

test('seriesToFrames: maps to ReplayPriceFeed frame shape', () => {
  const frames = seriesToFrames([1, 2, 3], 'ATOM');
  assert.deepEqual(frames, [{ ATOM: 1 }, { ATOM: 2 }, { ATOM: 3 }]);
});
