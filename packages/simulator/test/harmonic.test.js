import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitHarmonicModel,
  detectFrequencies,
  leastSquares,
  solveLinear,
} from '../harmonic.js';
import { HarmonicPriceFeed } from '../price-feed.js';
import { makeWorld } from '../world.js';
import { forecast } from '../forecast.js';
import { evaluateForecast } from '../forecast-eval.js';
import { cyclicSeries, gbmSeries, synthesisSeries } from '../fixtures.js';
import { PRESETS, generate, presetByName } from './fixtures/presets.js';

// --- linear algebra primitives ---

test('solveLinear: solves a known 3x3 system', () => {
  // [2 1 -1; -3 -1 2; -2 1 2] x = [8; -11; -3]  =>  x = [2; 3; -1]
  const m = [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]];
  const b = [8, -11, -3];
  const x = solveLinear(m, b);
  assert.ok(Math.abs(x[0] - 2) < 1e-9, `x0 ${x[0]}`);
  assert.ok(Math.abs(x[1] - 3) < 1e-9, `x1 ${x[1]}`);
  assert.ok(Math.abs(x[2] + 1) < 1e-9, `x2 ${x[2]}`);
});

test('leastSquares: recovers the slope and intercept of a noiseless line', () => {
  const n = 50;
  const xs = [];
  const ys = [];
  for (let t = 0; t < n; t += 1) { xs.push(t); ys.push(3 + 2 * t); }
  const coeffs = leastSquares([xs.map(() => 1), xs], ys);
  assert.ok(Math.abs(coeffs[0] - 3) < 1e-9, `intercept ${coeffs[0]}`);
  assert.ok(Math.abs(coeffs[1] - 2) < 1e-9, `slope ${coeffs[1]}`);
});

// --- frequency detection ---

test('detectFrequencies: recovers a planted frequency on a clean sinusoid', () => {
  const n = 2000;
  const f0 = 1 / 25;
  const signal = [];
  for (let t = 0; t < n; t += 1) signal.push(Math.sin(2 * Math.PI * f0 * t));
  const freqs = detectFrequencies(signal, {
    maxHarmonics: 4, peakRatio: 16, minPeriod: 3, maxPeriodFraction: 1 / 3, oversample: 4, length: n,
  });
  assert.ok(freqs.length >= 1, 'found at least one frequency');
  assert.ok(freqs.some((f) => Math.abs(f - f0) < 1e-3), `recovered ${freqs} ~ ${f0}`);
});

test('detectFrequencies: returns nothing for white noise (no spurious cycle)', () => {
  // Deterministic pseudo-noise via a fixed recurrence (no RNG dependency).
  const n = 2000;
  const signal = [];
  let s = 12345;
  for (let t = 0; t < n; t += 1) {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    signal.push((s / 0x7fffffff) - 0.5);
  }
  const freqs = detectFrequencies(signal, {
    maxHarmonics: 8, peakRatio: 16, minPeriod: 3, maxPeriodFraction: 1 / 3, oversample: 4, length: n,
  });
  assert.equal(freqs.length, 0, `white noise should select no harmonics, got ${freqs}`);
});

// --- model fit ---

test('fitHarmonicModel: recovers frequency and amplitude of a cyclic series', () => {
  const amplitude = 0.1;
  const frequency = 1 / 32;
  const { series } = cyclicSeries({ initialPrice: 100, amplitude, frequency, length: 4000 });
  const model = fitHarmonicModel(series);
  assert.ok(model.harmonics.length >= 1, 'fit at least one harmonic');
  const fundamental = model.harmonics.reduce((best, h) => (h.amplitude > best.amplitude ? h : best));
  assert.ok(Math.abs(fundamental.frequency - frequency) < 1e-3,
    `frequency ${fundamental.frequency} ~ ${frequency}`);
  // log(1 + a*sin) has fundamental amplitude ~ a for small a; expect within 30%.
  assert.ok(Math.abs(fundamental.amplitude - amplitude) < 0.3 * amplitude,
    `amplitude ${fundamental.amplitude} ~ ${amplitude}`);
  assert.ok(model.rSquared > 0.95, `rSquared ${model.rSquared}`);
});

test('fitHarmonicModel: a pure GBM series selects no harmonics and degrades to a trend', () => {
  const { series } = gbmSeries({ initialPrice: 100, mu: 0.0005, sigma: 0.02, length: 4000, seed: 7 });
  const model = fitHarmonicModel(series);
  assert.equal(model.harmonics.length, 0, `GBM should select no harmonics, got ${model.harmonics.length}`);
  // Residual sigma recovers the GBM volatility (≈ 0.02).
  assert.ok(Math.abs(model.residualSigma - 0.02) < 0.004, `residualSigma ${model.residualSigma}`);
});

// --- price feed ---

test('HarmonicPriceFeed: a zero-residual feed replays the deterministic seasonal level', () => {
  const model = { drift: 0.001, harmonics: [{ frequency: 1 / 20, alpha: 0.05, beta: 0.0 }], residualSigma: 0 };
  const feed = new HarmonicPriceFeed({ initialPrices: { ASSET: 100 }, models: { ASSET: model }, seed: 5 });
  assert.equal(feed.current().ASSET, 100);
  for (let t = 1; t <= 40; t += 1) {
    const got = feed.tick().ASSET;
    const rel = model.drift * t + model.harmonics[0].alpha * (Math.cos(2 * Math.PI / 20 * t) - 1);
    const want = 100 * Math.exp(rel);
    assert.ok(Math.abs(got - want) < 1e-9, `t=${t} got ${got} want ${want}`);
  }
});

test('HarmonicPriceFeed: same seed is byte-identical; reseed forks an independent path', () => {
  const model = { drift: 0, harmonics: [{ frequency: 1 / 16, alpha: 0.04, beta: 0.02 }], residualSigma: 0.01 };
  const a = new HarmonicPriceFeed({ initialPrices: { ASSET: 100 }, models: { ASSET: model }, seed: 11 });
  const b = new HarmonicPriceFeed({ initialPrices: { ASSET: 100 }, models: { ASSET: model }, seed: 11 });
  const c = new HarmonicPriceFeed({ initialPrices: { ASSET: 100 }, models: { ASSET: model }, seed: 99 });
  let diverged = false;
  for (let t = 0; t < 30; t += 1) {
    const pa = a.tick().ASSET;
    const pb = b.tick().ASSET;
    const pc = c.tick().ASSET;
    assert.equal(pa, pb, `same seed must match at t=${t}`);
    if (Math.abs(pa - pc) > 1e-9) diverged = true;
  }
  assert.ok(diverged, 'different seeds must produce a different residual path');
});

test('HarmonicPriceFeed: a clone reseeded at t=0 diverges while sharing the seasonal center', () => {
  const model = { drift: 0, harmonics: [{ frequency: 1 / 12, alpha: 0.06, beta: 0 }], residualSigma: 0.02 };
  const parent = new HarmonicPriceFeed({ initialPrices: { ASSET: 100 }, models: { ASSET: model }, seed: 3 });
  const childA = parent.clone({ seed: 1000 });
  const childB = parent.clone({ seed: 1001 });
  const seriesA = [];
  const seriesB = [];
  for (let t = 0; t < 50; t += 1) { seriesA.push(childA.tick().ASSET); seriesB.push(childB.tick().ASSET); }
  // The two paths differ (independent residual walks)...
  assert.ok(seriesA.some((v, i) => Math.abs(v - seriesB[i]) > 1e-9), 'forked paths must differ');
  // ...but their geometric mean tracks the shared deterministic center: the
  // residual walk has zero drift, so averaging many forks collapses toward it.
  const center = [];
  for (let t = 1; t <= 50; t += 1) center.push(100 * Math.exp(model.harmonics[0].alpha * (Math.cos(2 * Math.PI / 12 * t) - 1)));
  // A coarse sanity bound: both paths stay within a few residual-sigma-sqrt(t) of center.
  for (let i = 0; i < 50; i += 1) {
    const band = center[i] * 6 * model.residualSigma * Math.sqrt(i + 1);
    assert.ok(Math.abs(seriesA[i] - center[i]) < band + 1, `A drifted off center at ${i}`);
  }
});

// --- integration: the harmonic feed plugs into forecast() unchanged ---

test('forecast: a harmonic feed yields a cycle-centered ensemble', () => {
  const model = { drift: 0, harmonics: [{ frequency: 1 / 16, alpha: 0.08, beta: 0 }], residualSigma: 0.005 };
  const world = makeWorld({
    portfolio: { cash: 0, balances: { ASSET: 1 }, initialPrice: 100 },
    priceFeed: { kind: 'harmonic', initialPrices: { ASSET: 100 }, models: { ASSET: model }, seed: 1000 },
  });
  const fc = forecast({ from: world, horizon: 8, ensembleSize: 200, baseSeed: 1000 });
  // At horizon 8 (half a period of f=1/16) the cosine cycle pulls the level
  // below 100; the ensemble median should reflect that deterministic dip.
  const rel = model.harmonics[0].alpha * (Math.cos(2 * Math.PI / 16 * 8) - 1); // = alpha*(-2)
  const center = 100 * Math.exp(rel);
  assert.ok(Math.abs(fc.summary.meanEquity - center) < 1.0,
    `mean ${fc.summary.meanEquity} ~ center ${center}`);
});

// --- the eval-table claim: harmonic beats GBM on cyclic + synthesis ---

test('evaluateForecast: harmonic beats GBM on CRPS / point error for a cyclic oracle', () => {
  const base = {
    initialPrice: 100, horizon: 32, ensembleSize: 300, realizationCount: 400,
    generate: (ov) => cyclicSeries({ ...presetByName('cyclic-wild').params, ...ov }),
  };
  const g = evaluateForecast({ ...base, forecaster: 'gbm' });
  const h = evaluateForecast({ ...base, forecaster: 'harmonic' });
  assert.ok(h.score.crps < 0.5 * g.score.crps, `harmonic crps ${h.score.crps} vs gbm ${g.score.crps}`);
  assert.ok(h.score.relPointError < g.score.relPointError,
    `harmonic relPE ${h.score.relPointError} vs gbm ${g.score.relPointError}`);
  assert.ok(h.harmonicModel.harmonics.length >= 1, 'harmonic model fit a cycle');
});

test('evaluateForecast: harmonic improves CRPS and PIT on a turbulent synthesis oracle', () => {
  const base = {
    initialPrice: 100, horizon: 32, ensembleSize: 300, realizationCount: 400,
    generate: (ov) => synthesisSeries({ ...presetByName('synthesis-turbulent').params, ...ov }),
  };
  const g = evaluateForecast({ ...base, forecaster: 'gbm' });
  const h = evaluateForecast({ ...base, forecaster: 'harmonic' });
  assert.ok(h.score.crps < g.score.crps, `harmonic crps ${h.score.crps} vs gbm ${g.score.crps}`);
  assert.ok(h.score.pitKs < g.score.pitKs, `harmonic pitKs ${h.score.pitKs} vs gbm ${g.score.pitKs}`);
});

test('evaluateForecast: harmonic does not regress the GBM presets', () => {
  for (const name of ['gbm-flat-lowvol', 'gbm-bull', 'gbm-bear-volatile']) {
    const preset = presetByName(name);
    const base = {
      initialPrice: 100, horizon: 32, ensembleSize: 300, realizationCount: 400,
      generate: (ov) => generate(preset, ov),
    };
    const g = evaluateForecast({ ...base, forecaster: 'gbm' });
    const h = evaluateForecast({ ...base, forecaster: 'harmonic' });
    assert.equal(h.harmonicModel.harmonics.length, 0, `${name}: GBM data should select no harmonics`);
    // No meaningful degradation: CRPS within 5% and PIT-KS no worse by > 0.03.
    assert.ok(h.score.crps <= g.score.crps * 1.05 + 1e-9, `${name}: crps ${h.score.crps} vs ${g.score.crps}`);
    assert.ok(h.score.pitKs <= g.score.pitKs + 0.03, `${name}: pitKs ${h.score.pitKs} vs ${g.score.pitKs}`);
  }
});

test('evaluateForecast: harmonic improves CRPS on every cyclic and synthesis preset', () => {
  for (const preset of PRESETS.filter((p) => p.kind === 'cyclic' || p.kind === 'synthesis')) {
    const base = {
      initialPrice: 100, horizon: 32, ensembleSize: 200, realizationCount: 300,
      generate: (ov) => generate(preset, ov),
    };
    const g = evaluateForecast({ ...base, forecaster: 'gbm' });
    const h = evaluateForecast({ ...base, forecaster: 'harmonic' });
    assert.ok(h.score.crps <= g.score.crps + 1e-9, `${preset.name}: harmonic crps ${h.score.crps} vs gbm ${g.score.crps}`);
  }
});
