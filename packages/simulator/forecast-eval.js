/**
 * Forecast-evaluation harness.
 *
 * The ensemble forecaster (`forecast.js`) projects a distribution of terminal
 * outcomes by forking a GBM world into an ensemble. This module scores that
 * predicted distribution against *realized* outcomes drawn from a known
 * generating process — so, because the generating process is known, we can
 * measure whether the ensemble recovers the distribution it should.
 *
 * The contract is honest about what the forecaster is: it fits a GBM to an
 * observed training window and projects that GBM forward. When the true
 * process is itself GBM the forecast is well calibrated (coverage ~ nominal,
 * low CRPS, near-uniform PIT). When the true process has structure GBM
 * cannot capture (a cyclic oracle that mean-reverts), the harness *surfaces*
 * the miscalibration (intervals too wide, coverage above nominal). That
 * contrast is the point of the eval table.
 *
 * Scoring vocabulary:
 *   - CRPS (continuous ranked probability score) — proper score for the
 *     whole distribution; 0 iff the forecast is a point mass at the
 *     observation. Lower is better.
 *   - pinball (quantile) loss — proper score for a single quantile.
 *   - interval coverage / hit-rate — fraction of realized outcomes inside a
 *     central predictive interval; should match the nominal level.
 *   - PIT (probability integral transform) — where each realized outcome
 *     falls in the forecast CDF; uniform iff calibrated.
 *   - point error — |median forecast - mean realized|.
 */

import { forecast } from './forecast.js';
import { makeWorld } from './world.js';
import { quantileSorted } from './bootstrap.js';
import { seriesLogReturns } from './fixtures.js';
import { fitHarmonicModel } from './harmonic.js';

/**
 * Sample mean and variance (population, /N) of a numeric array.
 *
 * @param {number[]} xs
 * @returns {{mean: number, variance: number}}
 */
function momentsPopulation(xs) {
  const n = xs.length;
  if (n === 0) return { mean: 0, variance: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / n;
  return { mean, variance };
}

/**
 * Fit GBM parameters (mu, sigma) from an observed price series, inverting
 * the GBM step law: per-step log-return ~ N((mu - sigma^2/2)*dt, sigma^2*dt).
 *
 * @param {number[]} series
 * @param {number} [dt]                 default 1
 * @returns {{mu: number, sigma: number, logReturnMean: number, logReturnVariance: number}}
 */
export function fitGbm(series, dt = 1) {
  const rets = seriesLogReturns(series);
  const { mean, variance } = momentsPopulation(rets);
  const sigma = Math.sqrt(Math.max(0, variance) / dt);
  // mean = (mu - sigma^2/2)*dt  =>  mu = mean/dt + sigma^2/2
  const mu = mean / dt + 0.5 * sigma * sigma;
  return { mu, sigma, logReturnMean: mean, logReturnVariance: variance };
}

/**
 * Mean pairwise absolute difference E|X - X'| of an ensemble, the
 * spread term of the empirical CRPS. O(N log N) via the sorted identity
 *   sum_{i,j} |x_i - x_j| = 2 * sum_i (2i - N - 1) x_(i)   (1-indexed sorted).
 *
 * @param {number[]} sorted             ascending
 * @returns {number}
 */
export function ensembleSpread(sorted) {
  const n = sorted.length;
  if (n < 2) return 0;
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    // 1-indexed coefficient (2*(i+1) - n - 1) = (2i - n + 1)
    acc += (2 * i - n + 1) * sorted[i];
  }
  // sum_{i,j}|.| = 2*acc ; E|X-X'| = (1/N^2) * sum_{i,j} = 2*acc / N^2
  return (2 * acc) / (n * n);
}

/**
 * Empirical CRPS of an ensemble forecast against one observation.
 *
 *   CRPS = (1/N) sum_i |x_i - y|  -  (1/2) E|X - X'|
 *
 * @param {number[]} ensemble
 * @param {number} y
 * @param {number} [precomputedSpread]  E|X-X'| if already known
 * @returns {number}
 */
export function crps(ensemble, y, precomputedSpread) {
  const n = ensemble.length;
  if (n === 0) return NaN;
  const meanAbs = ensemble.reduce((acc, x) => acc + Math.abs(x - y), 0) / n;
  const spread = precomputedSpread != null
    ? precomputedSpread
    : ensembleSpread(ensemble.slice().sort((a, b) => a - b));
  return meanAbs - 0.5 * spread;
}

/**
 * Pinball (quantile) loss of a forecast quantile against an observation.
 *
 * @param {number} forecastQuantile
 * @param {number} y
 * @param {number} q                    quantile level in (0,1)
 * @returns {number}
 */
export function pinballLoss(forecastQuantile, y, q) {
  const d = y - forecastQuantile;
  return d >= 0 ? q * d : (q - 1) * d;
}

/**
 * Probability integral transform of an observation under an ensemble CDF:
 * the fraction of ensemble members at or below the observation.
 *
 * @param {number[]} sortedEnsemble     ascending
 * @param {number} y
 * @returns {number}                    in [0, 1]
 */
export function pit(sortedEnsemble, y) {
  let lo = 0;
  let hi = sortedEnsemble.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEnsemble[mid] <= y) lo = mid + 1; else hi = mid;
  }
  return lo / sortedEnsemble.length;
}

/**
 * Kolmogorov-Smirnov distance of a set of PIT values from uniform[0,1].
 * 0 means perfectly uniform (calibrated); larger means more miscalibrated.
 *
 * @param {number[]} pits
 * @returns {number}
 */
export function pitUniformityKs(pits) {
  if (pits.length === 0) return NaN;
  const sorted = pits.slice().sort((a, b) => a - b);
  const n = sorted.length;
  let d = 0;
  for (let i = 0; i < n; i += 1) {
    const empiricalHi = (i + 1) / n;
    const empiricalLo = i / n;
    d = Math.max(d, Math.abs(empiricalHi - sorted[i]), Math.abs(sorted[i] - empiricalLo));
  }
  return d;
}

/**
 * Score a predicted ensemble against a set of realized outcomes.
 *
 * @param {number[]} ensemble           predicted terminal values
 * @param {number[]} realized           held-out realized terminal values
 * @param {object} [opts]
 * @param {number[]} [opts.coverageLevels]   central interval levels (default [0.5,0.8,0.9])
 * @param {number[]} [opts.pinballQuantiles] quantiles for pinball loss (default [0.1,0.5,0.9])
 * @returns {object}
 */
export function scoreForecast(ensemble, realized, opts = {}) {
  const coverageLevels = opts.coverageLevels || [0.5, 0.8, 0.9];
  const pinballQuantiles = opts.pinballQuantiles || [0.1, 0.5, 0.9];
  const sorted = ensemble.slice().sort((a, b) => a - b);
  const spread = ensembleSpread(sorted);

  // CRPS averaged over realized observations.
  const crpsMean = realized.reduce((acc, y) => acc + crps(ensemble, y, spread), 0) / realized.length;

  // Pinball loss per quantile, averaged over realized observations.
  const pinball = {};
  for (const q of pinballQuantiles) {
    const fq = quantileSorted(sorted, q);
    pinball[q] = realized.reduce((acc, y) => acc + pinballLoss(fq, y, q), 0) / realized.length;
  }

  // Interval coverage / hit-rate per nominal central level.
  const coverage = {};
  for (const level of coverageLevels) {
    const lo = quantileSorted(sorted, (1 - level) / 2);
    const hi = quantileSorted(sorted, (1 + level) / 2);
    const inside = realized.filter((y) => y >= lo && y <= hi).length;
    coverage[level] = inside / realized.length;
  }

  // PIT calibration.
  const pits = realized.map((y) => pit(sorted, y));
  const pitMean = pits.reduce((a, b) => a + b, 0) / pits.length;
  const pitKs = pitUniformityKs(pits);

  // Point error: forecast median vs realized mean.
  const medianForecast = quantileSorted(sorted, 0.5);
  const realizedMean = realized.reduce((a, b) => a + b, 0) / realized.length;
  const pointError = Math.abs(medianForecast - realizedMean);
  const relPointError = realizedMean !== 0 ? pointError / Math.abs(realizedMean) : NaN;

  return {
    crps: crpsMean,
    pinball,
    coverage,
    pitMean,
    pitKs,
    pointError,
    relPointError,
    medianForecast,
    realizedMean,
    ensembleMean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

/**
 * Evaluate the ensemble forecaster against a known generating process.
 *
 * The flow:
 *   1. Fit GBM (mu_hat, sigma_hat) from a training realization of the
 *      process (what a real forecaster sees: a history window).
 *   2. Run the ensemble forecaster from a single-asset, all-in world priced
 *      by GBM(mu_hat, sigma_hat); the terminal-equity ensemble is the
 *      prediction.
 *   3. Draw `realizationCount` independent realizations of the *true*
 *      process and read each one's terminal price at the horizon — the
 *      held-out outcomes.
 *   4. Score the prediction against the realized outcomes.
 *
 * @param {object} cfg
 * @param {(overrides: object) => {series: number[], meta: object}} cfg.generate
 *        builds a realization of the true process given `{ seed, length }`
 * @param {number} cfg.initialPrice
 * @param {number} [cfg.horizon]             default 32
 * @param {number} [cfg.ensembleSize]        default 200
 * @param {number} [cfg.trainLength]         training-window length, default 4000
 *        (long enough that the GBM drift estimate is not swamped by sampling
 *        noise; with a short window the drift error dominates calibration —
 *        an honest finding the harness can also surface by shrinking it)
 * @param {number} [cfg.trainSeed]           default 1
 * @param {number} [cfg.realizationCount]    held-out draws, default 400
 * @param {number} [cfg.realizeSeedBase]     default 900000
 * @param {number} [cfg.baseSeed]            forecaster child-seed anchor, default 1000
 * @param {object} [cfg.scoreOpts]           forwarded to scoreForecast
 * @param {'gbm'|'harmonic'} [cfg.forecaster] which model to fit, default 'gbm'
 * @param {object} [cfg.harmonicOpts]        forwarded to fitHarmonicModel when forecaster='harmonic'
 * @returns {object}
 */
export function evaluateForecast(cfg) {
  const horizon = cfg.horizon != null ? cfg.horizon : 32;
  const ensembleSize = cfg.ensembleSize != null ? cfg.ensembleSize : 200;
  const trainLength = cfg.trainLength != null ? cfg.trainLength : 4000;
  const trainSeed = cfg.trainSeed != null ? cfg.trainSeed : 1;
  const realizationCount = cfg.realizationCount != null ? cfg.realizationCount : 400;
  const realizeSeedBase = cfg.realizeSeedBase != null ? cfg.realizeSeedBase : 900000;
  const baseSeed = cfg.baseSeed != null ? cfg.baseSeed : 1000;
  const forecaster = cfg.forecaster || 'gbm';

  // 1. Fit a model from a training realization (what a real forecaster
  //    sees: a history window).
  const training = cfg.generate({ seed: trainSeed, length: trainLength });
  const fit = fitGbm(training.series);

  // 2. Forecast from an all-in single-asset world: equity == terminal price.
  //    The feed kind is the model under test; both are scored unchanged by
  //    the same fork-based forecast() path below.
  let priceFeed;
  let harmonicModel = null;
  if (forecaster === 'harmonic') {
    harmonicModel = fitHarmonicModel(training.series, cfg.harmonicOpts);
    priceFeed = {
      kind: 'harmonic',
      initialPrices: { ASSET: cfg.initialPrice },
      models: { ASSET: harmonicModel },
      seed: baseSeed,
    };
  } else {
    priceFeed = {
      kind: 'gbm',
      initialPrices: { ASSET: cfg.initialPrice },
      drifts: { ASSET: fit.mu },
      volatilities: { ASSET: fit.sigma },
      seed: baseSeed,
    };
  }
  const world = makeWorld({
    portfolio: { cash: 0, balances: { ASSET: 1 }, initialPrice: cfg.initialPrice },
    priceFeed,
  });
  const fc = forecast({ from: world, horizon, ensembleSize, baseSeed });
  const ensemble = fc.outcomes.map((o) => o.finalEquity);

  // 3. Realized outcomes from the true process.
  const realized = [];
  for (let r = 0; r < realizationCount; r += 1) {
    const real = cfg.generate({ seed: realizeSeedBase + r, length: horizon });
    realized.push(real.series[horizon]);
  }

  // 4. Score.
  const score = scoreForecast(ensemble, realized, cfg.scoreOpts);

  return {
    forecaster,
    fit,
    harmonicModel,
    horizon,
    ensembleSize,
    realizationCount,
    ensembleStats: {
      mean: score.ensembleMean,
      p05: quantileSorted(ensemble.slice().sort((a, b) => a - b), 0.05),
      p50: score.medianForecast,
      p95: quantileSorted(ensemble.slice().sort((a, b) => a - b), 0.95),
    },
    score,
    histogram: fc.histogram,
  };
}

/**
 * Run `evaluateForecast` across a set of presets and return a compact eval
 * table (one row per preset).
 *
 * @param {Array<{name: string, kind: string, params: object}>} presets
 * @param {(preset: object, overrides: object) => {series: number[], meta: object}} generateFor
 *        e.g. `(preset, ov) => presetsModule.generate(preset, ov)`
 * @param {object} [cfg]                forwarded to evaluateForecast (minus generate/initialPrice)
 * @returns {Array<object>}
 */
export function evalTableOverPresets(presets, generateFor, cfg = {}) {
  return presets.map((preset) => {
    const initialPrice = preset.params.initialPrice != null ? preset.params.initialPrice : 100;
    const result = evaluateForecast({
      ...cfg,
      initialPrice,
      generate: (overrides) => generateFor(preset, overrides),
    });
    return {
      name: preset.name,
      kind: preset.kind,
      forecaster: result.forecaster,
      fittedMu: result.fit.mu,
      fittedSigma: result.fit.sigma,
      harmonicCount: result.harmonicModel ? result.harmonicModel.harmonics.length : 0,
      crps: result.score.crps,
      coverage90: result.score.coverage[0.9],
      coverage50: result.score.coverage[0.5],
      pitKs: result.score.pitKs,
      pinballMedian: result.score.pinball[0.5],
      relPointError: result.score.relPointError,
    };
  });
}

/**
 * Run both the GBM and the harmonic forecaster over a preset set and pair
 * the rows, so the eval table can show the before/after of swapping in the
 * cyclical-structure-aware model. The deltas use the convention "harmonic
 * minus GBM" for the error metrics (negative is an improvement) and the
 * absolute distance from nominal for coverage.
 *
 * @param {Array<{name: string, kind: string, params: object}>} presets
 * @param {(preset: object, overrides: object) => {series: number[], meta: object}} generateFor
 * @param {object} [cfg]                forwarded to evaluateForecast (minus generate/initialPrice/forecaster)
 * @returns {Array<object>}
 */
export function compareForecastersOverPresets(presets, generateFor, cfg = {}) {
  const gbm = evalTableOverPresets(presets, generateFor, { ...cfg, forecaster: 'gbm' });
  const harmonic = evalTableOverPresets(presets, generateFor, { ...cfg, forecaster: 'harmonic' });
  return presets.map((preset, i) => {
    const g = gbm[i];
    const h = harmonic[i];
    return {
      name: preset.name,
      kind: preset.kind,
      harmonicCount: h.harmonicCount,
      gbm: g,
      harmonic: h,
      crpsDelta: h.crps - g.crps,
      crpsRatio: g.crps !== 0 ? h.crps / g.crps : NaN,
      pitKsDelta: h.pitKs - g.pitKs,
      relPointErrorDelta: h.relPointError - g.relPointError,
      coverage90AbsErrGbm: Math.abs(g.coverage90 - 0.9),
      coverage90AbsErrHarmonic: Math.abs(h.coverage90 - 0.9),
    };
  });
}
