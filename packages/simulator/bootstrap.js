/**
 * Bootstrap confidence bands on quantile estimates.
 *
 * A single ensemble of N draws gives one point estimate per quantile,
 * but at the tails (p01, p99) that estimate is noisy — it rests on a
 * handful of order statistics. The nonparametric bootstrap quantifies
 * that noise: resample the ensemble with replacement B times, recompute
 * each quantile on every resample, and report the spread of those B
 * recomputations as a confidence band. No distributional assumption is
 * made; the band is read straight off the resample distribution.
 *
 * Determinism: resampling uses a *seeded* sfc32 stream, so the same
 * values + same seed + same B yield byte-identical bands. Never calls
 * Math.random.
 */

import { sfc32 } from './price-feed.js';

/**
 * @typedef {object} QuantileBand
 * @property {number} q          the quantile level (e.g. 0.01)
 * @property {number} point      point estimate on the original ensemble
 * @property {number} lo         lower confidence bound
 * @property {number} hi         upper confidence bound
 * @property {number} stderr     bootstrap standard error of the estimate
 */

/**
 * The textbook quantile of a numeric array (nearest-rank on the sorted
 * sample; matches the convention used elsewhere in the simulator).
 *
 * @param {number[]} sorted      ascending-sorted array
 * @param {number} q             in [0, 1]
 * @returns {number}
 */
export function quantileSorted(sorted, q) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

/**
 * Compute bootstrap confidence bands for a set of quantiles.
 *
 * @param {number[]} values            the ensemble (terminal equities, drawdowns, ...)
 * @param {object} [opts]
 * @param {number[]} [opts.quantiles]  quantile levels (default tail-heavy set)
 * @param {number} [opts.resamples]    B, number of bootstrap resamples (default 500)
 * @param {number} [opts.seed]         RNG seed (default 90210)
 * @param {number} [opts.ci]           central confidence mass (default 0.95)
 * @returns {QuantileBand[]}
 */
export function bootstrapQuantileBands(values, opts = {}) {
  const quantiles = opts.quantiles || [0.01, 0.05, 0.5, 0.95, 0.99];
  const B = opts.resamples != null ? opts.resamples : 500;
  const seed = opts.seed != null ? opts.seed : 90210;
  const ci = opts.ci != null ? opts.ci : 0.95;
  const n = values.length;

  const sortedOriginal = values.slice().sort((a, b) => a - b);
  const points = quantiles.map((q) => quantileSorted(sortedOriginal, q));

  if (n === 0) {
    return quantiles.map((q, i) => ({ q, point: points[i], lo: NaN, hi: NaN, stderr: NaN }));
  }
  if (n === 1) {
    return quantiles.map((q, i) => ({ q, point: points[i], lo: values[0], hi: values[0], stderr: 0 }));
  }

  const rng = sfc32(seed);
  // For each quantile, collect B bootstrap recomputations.
  /** @type {number[][]} */
  const dist = quantiles.map(() => new Array(B));
  const resample = new Array(n);
  for (let b = 0; b < B; b += 1) {
    for (let i = 0; i < n; i += 1) {
      const idx = Math.min(n - 1, Math.floor(rng() * n));
      resample[i] = values[idx];
    }
    resample.sort((a, b2) => a - b2);
    for (let k = 0; k < quantiles.length; k += 1) {
      dist[k][b] = quantileSorted(resample, quantiles[k]);
    }
  }

  const loP = (1 - ci) / 2;
  const hiP = 1 - loP;
  return quantiles.map((q, k) => {
    const col = dist[k].slice().sort((a, b2) => a - b2);
    const lo = quantileSorted(col, loP);
    const hi = quantileSorted(col, hiP);
    const mean = col.reduce((a, b2) => a + b2, 0) / col.length;
    const variance = col.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (col.length - 1);
    return { q, point: points[k], lo, hi, stderr: Math.sqrt(variance) };
  });
}
