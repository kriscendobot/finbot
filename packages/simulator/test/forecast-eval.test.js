import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitGbm,
  crps,
  ensembleSpread,
  pinballLoss,
  pit,
  pitUniformityKs,
  scoreForecast,
  evaluateForecast,
  evalTableOverPresets,
} from '../forecast-eval.js';
import { gbmSeries, cyclicSeries } from '../fixtures.js';
import { PRESETS, generate, presetByName } from './fixtures/presets.js';

// --- fitGbm ---

test('fitGbm: recovers mu and sigma from a GBM series', () => {
  const mu = 0.0012;
  const sigma = 0.025;
  const { series } = gbmSeries({ mu, sigma, length: 60000, seed: 3 });
  const fit = fitGbm(series);
  assert.ok(Math.abs(fit.mu - mu) < 5e-4, `mu ${fit.mu}`);
  assert.ok(Math.abs(fit.sigma - sigma) < 5e-4, `sigma ${fit.sigma}`);
});

// --- CRPS ---

test('crps: zero for a point mass at the observation', () => {
  const ens = new Array(50).fill(7);
  assert.ok(Math.abs(crps(ens, 7)) < 1e-12);
});

test('crps: lower when the ensemble is centered on the observation', () => {
  const near = [0.9, 1.0, 1.1];
  const far = [4.9, 5.0, 5.1];
  assert.ok(crps(near, 1.0) < crps(far, 1.0));
});

test('ensembleSpread: matches the brute-force mean pairwise abs difference', () => {
  const xs = [1, 4, 2, 9, 3];
  const sorted = xs.slice().sort((a, b) => a - b);
  let brute = 0;
  for (const a of xs) for (const b of xs) brute += Math.abs(a - b);
  brute /= xs.length * xs.length;
  assert.ok(Math.abs(ensembleSpread(sorted) - brute) < 1e-12);
});

// --- pinball ---

test('pinballLoss: symmetric at the median, asymmetric in the tails', () => {
  assert.ok(Math.abs(pinballLoss(0, 2, 0.5) - 1) < 1e-12); // 0.5 * 2
  assert.ok(Math.abs(pinballLoss(0, -2, 0.5) - 1) < 1e-12); // 0.5 * 2
  // For q=0.9, under-prediction (y above forecast) is penalized more.
  assert.ok(pinballLoss(0, 1, 0.9) > pinballLoss(0, -1, 0.9));
});

// --- PIT ---

test('pit: fraction of ensemble at or below the value', () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(pit(sorted, 2), 0.5);
  assert.equal(pit(sorted, 0), 0);
  assert.equal(pit(sorted, 5), 1);
});

test('pitUniformityKs: near zero for uniform-spaced PITs', () => {
  const pits = [];
  for (let i = 0; i < 100; i += 1) pits.push((i + 0.5) / 100);
  assert.ok(pitUniformityKs(pits) < 0.02);
});

// --- scoreForecast ---

test('scoreForecast: a calibrated ensemble beats a biased one on CRPS', () => {
  // realized ~ values near 100; calibrated ensemble centered there, biased one shifted.
  const realized = [];
  for (let i = 0; i < 200; i += 1) realized.push(100 + (i % 21) - 10);
  const calibrated = [];
  const biased = [];
  for (let i = 0; i < 200; i += 1) { calibrated.push(100 + (i % 21) - 10); biased.push(130 + (i % 21) - 10); }
  const sc = scoreForecast(calibrated, realized);
  const sb = scoreForecast(biased, realized);
  assert.ok(sc.crps < sb.crps);
  assert.ok(sc.pointError < sb.pointError);
});

// --- evaluateForecast end to end ---

test('evaluateForecast: GBM process is well calibrated (coverage ~ nominal, low pitKS)', () => {
  const result = evaluateForecast({
    initialPrice: 100,
    horizon: 32,
    ensembleSize: 300,
    realizationCount: 600,
    generate: (ov) => gbmSeries({ initialPrice: 100, mu: 0.0005, sigma: 0.02, ...ov }),
  });
  // Fitted params recover the true process.
  assert.ok(Math.abs(result.fit.sigma - 0.02) < 0.004, `sigma ${result.fit.sigma}`);
  // 90% interval covers ~90% of realized outcomes.
  assert.ok(result.score.coverage[0.9] > 0.8 && result.score.coverage[0.9] <= 1.0,
    `coverage90 ${result.score.coverage[0.9]}`);
  // PIT close to uniform.
  assert.ok(result.score.pitKs < 0.15, `pitKs ${result.score.pitKs}`);
});

test('evaluateForecast: a cyclic oracle exposes GBM over-dispersion (over-coverage)', () => {
  const gbm = evaluateForecast({
    initialPrice: 100,
    horizon: 32,
    ensembleSize: 300,
    realizationCount: 400,
    generate: (ov) => gbmSeries({ initialPrice: 100, mu: 0, sigma: 0.02, ...ov }),
  });
  const cyclic = evaluateForecast({
    initialPrice: 100,
    horizon: 32,
    ensembleSize: 300,
    realizationCount: 400,
    // A near-deterministic cycle: realized terminals cluster tightly, so a
    // GBM forecaster's wide interval over-covers and its PIT is non-uniform.
    generate: (ov) => cyclicSeries({ initialPrice: 100, amplitude: 0.08, frequency: 1 / 24, noiseSigma: 0.002, ...ov }),
  });
  assert.ok(cyclic.score.coverage[0.9] >= gbm.score.coverage[0.9]);
  assert.ok(cyclic.score.pitKs > gbm.score.pitKs,
    `cyclic pitKs ${cyclic.score.pitKs} should exceed gbm pitKs ${gbm.score.pitKs}`);
});

// --- table over presets ---

test('evalTableOverPresets: produces one finite row per preset', () => {
  const table = evalTableOverPresets(PRESETS, generate, {
    horizon: 24, ensembleSize: 120, realizationCount: 200,
  });
  assert.equal(table.length, PRESETS.length);
  for (const row of table) {
    assert.ok(Number.isFinite(row.crps), `${row.name} crps`);
    assert.ok(Number.isFinite(row.coverage90), `${row.name} cov90`);
    assert.ok(Number.isFinite(row.pitKs), `${row.name} pitKs`);
    assert.ok(row.coverage90 >= 0 && row.coverage90 <= 1);
  }
});

test('evalTableOverPresets: GBM preset is better calibrated than a wild cyclic one', () => {
  const table = evalTableOverPresets(
    [presetByName('gbm-flat-lowvol'), presetByName('cyclic-wild')],
    generate,
    { horizon: 24, ensembleSize: 150, realizationCount: 300 },
  );
  const gbmRow = table.find((r) => r.name === 'gbm-flat-lowvol');
  const cyclicRow = table.find((r) => r.name === 'cyclic-wild');
  assert.ok(gbmRow.pitKs < cyclicRow.pitKs,
    `gbm pitKs ${gbmRow.pitKs} vs cyclic ${cyclicRow.pitKs}`);
});
