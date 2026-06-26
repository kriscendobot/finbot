/**
 * @finbot/simulator — public API.
 *
 * The simulator wraps the cut-2 harness in a deterministic world so the
 * OODA loop can run continuously against a simulated portfolio + price
 * feed, the planner can spawn nested forecasts via fork(), and an
 * outside observer can measure efficacy.
 */

export { Portfolio } from './portfolio.js';
export {
  GBMPriceFeed,
  HarmonicPriceFeed,
  ReplayPriceFeed,
  parseCsvFrames,
  sfc32,
  splitmix32,
  gaussian,
} from './price-feed.js';
export {
  fitHarmonicModel,
  detectFrequencies,
  leastSquares,
  solveLinear,
} from './harmonic.js';
export { makeWorld, makePriceFeed, cloneWorld } from './world.js';
export { runSimulator, runSimulatorFromConfig } from './runner.js';
export {
  perTickMetrics,
  summaryMetrics,
  meanStddev,
  rowsToJsonl,
  rowsToCsv,
} from './metrics.js';
export { forecast, binHistogram, aggregatePathStats } from './forecast.js';
export {
  cholesky,
  applyCholesky,
  correlationMatrixFromPairs,
  choleskyFactorFor,
} from './correlation.js';
export { VolatilitySurface, surfaceFromPriceHistory } from './vol-surface.js';
export { slippageFill, gasCost } from './costs.js';
export { bootstrapQuantileBands, quantileSorted } from './bootstrap.js';
export { pathStatsOf } from './path-stats.js';
export { renderHistogramSvg } from './histogram-svg.js';
export { reflect, renderReflection, reflectAndRecord } from './self-improvement.js';
export {
  cyclicSeries,
  gbmSeries,
  synthesisSeries,
  blockBootstrapSeries,
  seriesLogReturns,
  seriesToFrames,
} from './fixtures.js';
export {
  fitGbm,
  crps,
  ensembleSpread,
  pinballLoss,
  pit,
  pitUniformityKs,
  scoreForecast,
  evaluateForecast,
  evalTableOverPresets,
  compareForecastersOverPresets,
} from './forecast-eval.js';
export {
  riskAversionFromTolerance,
  toleranceFromRiskAversion,
  riskRewardScore,
  rewardRiskOf,
  chooseStrategy,
  toleranceFrontier,
  inferToleranceFromMaxDrawdown,
  inferToleranceFromLottery,
} from './risk-reward.js';
export {
  growthInstrument,
  yieldInstrument,
  dividendInstrument,
  instrumentReturns,
  mixReturns,
  instrumentReturnDistribution,
} from './instruments.js';
export {
  defaultInstrumentSpecs,
  instrumentCandidates,
  runEvaluation,
  renderEvaluationText,
} from './evaluation.js';
