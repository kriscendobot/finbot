/**
 * Deterministic walk-forward model selection for conditional-volatility
 * surfaces. Callers supply candidate fitters. This module owns the strict
 * train/test split, one-step-ahead recursion, and QLIKE comparison.
 */

const VARIANCE_FLOOR = 1e-12;

/** @param {number} forecastVariance @param {number} realizedVariance @returns {number} */
export function qlikeLoss(forecastVariance, realizedVariance) {
  const variance = Math.max(VARIANCE_FLOOR, forecastVariance);
  return realizedVariance / variance + Math.log(variance);
}

/** @param {number[]} values @returns {number} */
function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

/**
 * Standard normal CDF, using a deterministic error-function approximation.
 * The approximation error is well below the precision the selection needs,
 * while avoiding a statistics dependency for this small simulator.
 *
 * @param {number} z
 * @returns {number}
 */
function normalCdf(z) {
  if (z === 0) return 0.5;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + sign * erf);
}

/**
 * Diebold-Mariano test for paired forecast losses. The reported differential
 * is `lossesA - lossesB`, so a negative value favors A. Long-run variance is
 * estimated with a Bartlett-weighted HAC estimator: loss differentials can
 * remain serially dependent even when the forecasts themselves are one step
 * ahead. The small-sample correction is the Harvey-Leybourne-Newbold form.
 *
 * This is diagnostic evidence — it tells whether one forecaster's held-out
 * QLIKE edge over another is distinguishable from noise; it does not authorize
 * a portfolio action.
 *
 * @param {number[]} lossesA paired losses for candidate A
 * @param {number[]} lossesB paired losses for candidate B
 * @param {object} [opts]
 * @param {number} [opts.horizon] forecast horizon (default 1)
 * @param {number} [opts.lag] Bartlett HAC lag (default floor(n^(1/3)))
 * @param {number} [opts.alpha] two-sided significance threshold (default 0.05)
 * @returns {{ n: number, horizon: number, lag: number, meanLossDifference: number, longRunVariance: number, standardError: number, statistic: number, pValue: number, alpha: number, significant: boolean, better: 'a'|'b'|null }}
 */
export function dieboldMariano(lossesA, lossesB, opts = {}) {
  if (!Array.isArray(lossesA) || !Array.isArray(lossesB) || lossesA.length !== lossesB.length || lossesA.length < 2) {
    throw new Error('dieboldMariano: need paired loss arrays with at least two observations');
  }
  if (!lossesA.every(Number.isFinite) || !lossesB.every(Number.isFinite)) {
    throw new Error('dieboldMariano: losses must be finite');
  }

  const n = lossesA.length;
  const horizon = opts.horizon != null ? opts.horizon : 1;
  const alpha = opts.alpha != null ? opts.alpha : 0.05;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > n) {
    throw new Error('dieboldMariano: horizon must be an integer from 1 through n');
  }
  if (!(alpha > 0 && alpha < 1)) throw new Error('dieboldMariano: alpha must be between 0 and 1');

  const defaultLag = Math.floor(n ** (1 / 3));
  const lag = opts.lag != null ? opts.lag : defaultLag;
  if (!Number.isInteger(lag) || lag < 0 || lag >= n) {
    throw new Error('dieboldMariano: lag must be an integer from 0 through n - 1');
  }

  const differential = lossesA.map((loss, index) => loss - lossesB[index]);
  const meanLossDifference = mean(differential);
  const autocovariance = (atLag) => {
    let total = 0;
    for (let i = atLag; i < n; i += 1) {
      total += (differential[i] - meanLossDifference) * (differential[i - atLag] - meanLossDifference);
    }
    return total / n;
  };
  let longRunVariance = autocovariance(0);
  for (let atLag = 1; atLag <= lag; atLag += 1) {
    longRunVariance += 2 * (1 - atLag / (lag + 1)) * autocovariance(atLag);
  }
  // Numerical roundoff can make an exactly-zero HAC estimate slightly negative.
  longRunVariance = Math.max(0, longRunVariance);
  const standardError = Math.sqrt(longRunVariance / n);
  const hlnFactor = Math.sqrt((n + 1 - 2 * horizon + (horizon * (horizon - 1)) / n) / n);
  let statistic;
  if (standardError === 0) statistic = meanLossDifference === 0 ? 0 : Math.sign(meanLossDifference) * Infinity;
  else statistic = (meanLossDifference / standardError) * hlnFactor;
  const pValue = Number.isFinite(statistic) ? Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(statistic))))) : 0;
  const significant = pValue < alpha;
  const better = significant ? (meanLossDifference < 0 ? 'a' : meanLossDifference > 0 ? 'b' : null) : null;
  return {
    n,
    horizon,
    lag,
    meanLossDifference,
    longRunVariance,
    standardError,
    statistic,
    pValue,
    alpha,
    significant,
    better,
  };
}

/**
 * Score conditional-volatility candidates on a held-out suffix of one
 * asset's price frames. Each candidate fits only the training prefix, and
 * every test forecast is emitted before its realized return is consumed.
 *
 * @param {Array<Record<string, number>>} priceFrames
 * @param {string} asset
 * @param {Array<{ name: string, fit: (frames: Array<Record<string, number>>) => object }>} candidates
 * @param {object} [opts]
 * @param {number} [opts.trainFraction]
 * @param {number} [opts.minTrainReturns]
 * @param {number} [opts.minTestReturns]
 * @returns {{ trainN: number, testN: number, qlike: Record<string, number>, losses: Record<string, number[]> }|null}
 */
export function walkForwardQlike(priceFrames, asset, candidates, opts = {}) {
  const trainFraction = opts.trainFraction != null ? opts.trainFraction : 0.6;
  const minTrainReturns = opts.minTrainReturns != null ? opts.minTrainReturns : 12;
  const minTestReturns = opts.minTestReturns != null ? opts.minTestReturns : 4;
  if (!(trainFraction > 0 && trainFraction < 1)) {
    throw new Error('walkForwardQlike: trainFraction must be between 0 and 1');
  }

  const returns = [];
  for (let index = 1; index < priceFrames.length; index += 1) {
    const previous = priceFrames[index - 1][asset];
    const current = priceFrames[index][asset];
    if (!(previous > 0 && current > 0)) return null;
    returns.push(Math.log(current / previous));
  }
  const splitAt = Math.floor(returns.length * trainFraction);
  if (splitAt < minTrainReturns || returns.length - splitAt < minTestReturns) return null;

  const trainingFrames = priceFrames.slice(0, splitAt + 1);
  const trainingMean = mean(returns.slice(0, splitAt));
  const residuals = returns.slice(splitAt).map((value) => value - trainingMean);
  const qlike = {};
  // Per-observation QLIKE losses, kept alongside the scalar mean so a caller
  // can run a paired Diebold-Mariano test (is one candidate's edge over
  // another distinguishable from noise?) without re-walking the test window.
  const losses = {};

  for (const candidate of candidates) {
    try {
      const surface = candidate.fit(trainingFrames);
      if (!surface.has(asset)) continue;
      let variance = surface.initialVariance(asset);
      const perStep = [];
      for (const residual of residuals) {
        perStep.push(qlikeLoss(variance, residual * residual));
        const deviation = Math.sqrt(variance);
        const shock = deviation > 0 ? residual / deviation : 0;
        variance = surface.nextVariance(asset, variance, shock);
      }
      if (perStep.every(Number.isFinite)) {
        qlike[candidate.name] = mean(perStep);
        losses[candidate.name] = perStep;
      }
    } catch (_error) {
      // A candidate that cannot fit this prefix provides no selection evidence.
    }
  }
  return { trainN: splitAt, testN: residuals.length, qlike, losses };
}
