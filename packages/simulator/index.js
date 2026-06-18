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
  ReplayPriceFeed,
  parseCsvFrames,
  sfc32,
  splitmix32,
  gaussian,
} from './price-feed.js';
export { makeWorld, makePriceFeed, cloneWorld } from './world.js';
export { runSimulator, runSimulatorFromConfig } from './runner.js';
export {
  perTickMetrics,
  summaryMetrics,
  meanStddev,
  rowsToJsonl,
  rowsToCsv,
} from './metrics.js';
export { forecast, binHistogram } from './forecast.js';
