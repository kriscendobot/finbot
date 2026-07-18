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
 * @returns {{ trainN: number, testN: number, qlike: Record<string, number> }|null}
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

  for (const candidate of candidates) {
    try {
      const surface = candidate.fit(trainingFrames);
      if (!surface.has(asset)) continue;
      let variance = surface.initialVariance(asset);
      const losses = [];
      for (const residual of residuals) {
        losses.push(qlikeLoss(variance, residual * residual));
        const deviation = Math.sqrt(variance);
        const shock = deviation > 0 ? residual / deviation : 0;
        variance = surface.nextVariance(asset, variance, shock);
      }
      if (losses.every(Number.isFinite)) qlike[candidate.name] = mean(losses);
    } catch (_error) {
      // A candidate that cannot fit this prefix provides no selection evidence.
    }
  }
  return { trainN: splitAt, testN: residuals.length, qlike };
}
