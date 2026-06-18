/**
 * Monte Carlo forecast via nested fork.
 *
 * The planner gives the forecaster:
 *
 *   - the current world (or a runSimulator over it)
 *   - a proposed action (a function the inner sim applies on tick 1)
 *   - an horizon (number of ticks to project)
 *   - an ensemble size N
 *
 * The forecaster:
 *
 *   1. For i in 0..N-1:
 *        child = fork(seed_i)
 *        apply the proposed action on child at t=1
 *        for j in 0..horizon-1: child.tick()
 *        record final equity (and other summary stats)
 *   2. Aggregate the N outcomes into a histogram + summary stats
 *      (mean, stddev, percentiles, P(profit), P(>threshold)).
 *
 * The forecast is itself a meta-simulation: each child is a complete
 * runSimulator instance, so the planner can recurse (forecast of a
 * forecast) up to whatever depth budget the planner enforces.
 *
 * Seeds are derived from a deterministic schedule (baseSeed,
 * baseSeed+1, ...) so two runs of the same forecast produce
 * byte-identical histograms.
 */

import { runSimulator } from './runner.js';
import { summaryMetrics } from './metrics.js';

/**
 * @typedef {object} ForecastOutcome
 * @property {number} seed
 * @property {number} finalEquity
 * @property {number} totalPnL
 * @property {number} pnlPct
 * @property {number} maxDrawdownPct
 * @property {number} sharpe
 */

/**
 * @typedef {object} ForecastResult
 * @property {ForecastOutcome[]} outcomes
 * @property {object} summary
 * @property {object} histogram                  binned distribution of final equity
 */

/**
 * Run a Monte Carlo forecast.
 *
 * @param {object} cfg
 * @param {import('./runner.js').Simulator | import('./world.js').World} cfg.from
 * @param {Function} [cfg.action]              (world, t, prices) -> void; applied at t=1
 * @param {number} cfg.horizon                 ticks per child run
 * @param {number} cfg.ensembleSize            number of children
 * @param {number} [cfg.baseSeed]              default 1000
 * @param {Function} [cfg.tickFn]              passed to child runSimulator (e.g. a planner)
 * @param {number} [cfg.profitThreshold]       absolute equity profit threshold for P(profit > x)
 * @param {number} [cfg.bins]                  histogram bin count, default 10
 * @returns {ForecastResult}
 */
export function forecast(cfg) {
  const baseSeed = cfg.baseSeed != null ? cfg.baseSeed : 1000;
  const ensembleSize = cfg.ensembleSize || 100;
  const horizon = cfg.horizon || 10;
  const bins = cfg.bins || 10;
  const profitThreshold = cfg.profitThreshold != null ? cfg.profitThreshold : 0;

  // Normalize: accept either a Simulator (has .fork) or a World.
  let parentSim;
  if (cfg.from && typeof cfg.from.fork === 'function') {
    parentSim = cfg.from;
  } else if (cfg.from && cfg.from.portfolio && cfg.from.priceFeed) {
    parentSim = runSimulator(cfg.from, { tickFn: cfg.tickFn, recordHistory: false });
  } else {
    throw new Error('forecast: cfg.from must be a Simulator or a World');
  }

  /** @type {ForecastOutcome[]} */
  const outcomes = [];
  for (let i = 0; i < ensembleSize; i += 1) {
    const seed = baseSeed + i;
    const child = parentSim.fork(seed, { tag: `forecast-${seed}` });
    // Apply the proposed action at t=1 (immediately after the first tick).
    // Wrap the child's tickFn so that on tick 1 the action fires.
    const childTickFn = (world, t, prices) => {
      let agentOut;
      if (cfg.tickFn) agentOut = cfg.tickFn(world, t, prices);
      if (t === 1 && cfg.action) cfg.action(world, t, prices);
      return agentOut;
    };
    // Replace the child sim with one that uses our wrapper.
    const innerSim = runSimulator(child.world, { tickFn: childTickFn, recordHistory: true });
    for (let j = 0; j < horizon; j += 1) innerSim.tick();
    const summary = summaryMetrics(innerSim.history);
    outcomes.push({
      seed,
      finalEquity: summary.finalEquity,
      totalPnL: summary.totalPnL,
      pnlPct: summary.pnlPct,
      maxDrawdownPct: summary.maxDrawdownPct,
      sharpe: summary.sharpe,
    });
  }

  const equities = outcomes.map((o) => o.finalEquity);
  const pnls = outcomes.map((o) => o.totalPnL);
  const { mean: meanEquity, stddev: stddevEquity } = momentsOf(equities);
  const { mean: meanPnL } = momentsOf(pnls);
  const sortedEq = equities.slice().sort((a, b) => a - b);
  const percentile = (p) => sortedEq[Math.min(sortedEq.length - 1, Math.floor(p * sortedEq.length))];
  const pProfit = pnls.filter((x) => x > profitThreshold).length / pnls.length;

  return {
    outcomes,
    summary: {
      ensembleSize,
      horizon,
      meanEquity,
      stddevEquity,
      meanPnL,
      p05: percentile(0.05),
      p25: percentile(0.25),
      p50: percentile(0.50),
      p75: percentile(0.75),
      p95: percentile(0.95),
      pProfit,
      profitThreshold,
    },
    histogram: binHistogram(equities, bins),
  };
}

/**
 * Bin a numeric array into a histogram.
 *
 * @param {number[]} values
 * @param {number} bins
 * @returns {object}                       { binEdges, counts, binWidth }
 */
export function binHistogram(values, bins) {
  if (values.length === 0) return { binEdges: [], counts: [], binWidth: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    // All values identical: single-bin degenerate histogram.
    return {
      binEdges: [min, min],
      counts: [values.length],
      binWidth: 0,
    };
  }
  const binWidth = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  const binEdges = [];
  for (let i = 0; i <= bins; i += 1) binEdges.push(min + i * binWidth);
  for (const v of values) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= bins) idx = bins - 1;
    counts[idx] += 1;
  }
  return { binEdges, counts, binWidth };
}

/**
 * @param {number[]} xs
 * @returns {{mean: number, stddev: number}}
 */
function momentsOf(xs) {
  if (xs.length === 0) return { mean: 0, stddev: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean, stddev: 0 };
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (xs.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}
