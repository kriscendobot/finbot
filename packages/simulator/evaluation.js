/**
 * Evaluation driver — the core deliverable, tying the three pieces together:
 *
 *   1. A forecast-evaluation table across the synthetic-oracle fixture
 *      presets (does the ensemble forecaster recover the distribution the
 *      known process should produce?).
 *   2. A risk/reward sweep over the user's volatility tolerance, across the
 *      three instrument types (growth / yield / dividend) plus a mixed
 *      strategy — the trade-off frontier.
 *
 * Everything is seeded and deterministic: two runs with the same config
 * produce identical tables. Simulation only; no funds, no chain.
 */

import { gbmSeries } from './fixtures.js';
import { evalTableOverPresets } from './forecast-eval.js';
import {
  growthInstrument,
  yieldInstrument,
  dividendInstrument,
  instrumentReturnDistribution,
  mixReturns,
} from './instruments.js';
import { toleranceFrontier, rewardRiskOf } from './risk-reward.js';

/**
 * Default per-instrument specs. Each instrument is driven by its own
 * underlying process so the three occupy genuinely different points in
 * risk/reward space (growth: volatile + appreciating; yield: calm + steady
 * accrual; dividend: in between), which is what makes the tolerance sweep
 * select different instruments at different appetites.
 *
 * @param {number} [initialPrice]
 * @returns {object}
 */
export function defaultInstrumentSpecs(initialPrice = 100) {
  return {
    growth: {
      underlying: { initialPrice, mu: 0.0016, sigma: 0.03 },
      make: (series) => growthInstrument({ asset: 'GROWTH', series }),
    },
    yield: {
      underlying: { initialPrice, mu: 0.0002, sigma: 0.008 },
      make: (series) => yieldInstrument({ asset: 'YIELD', series, yieldRate: 0.0007, accrualPeriod: 1 }),
    },
    dividend: {
      underlying: { initialPrice, mu: 0.0006, sigma: 0.016 },
      make: (series) => dividendInstrument({ asset: 'DIV', series, dividendPerUnit: 0.5, period: 16 }),
    },
  };
}

/**
 * Build the three single-instrument (reward, risk) candidates plus a mixed
 * growth+yield candidate, each over an ensemble of seeded realizations.
 *
 * @param {object} cfg
 * @param {number} [cfg.initialPrice]
 * @param {number} [cfg.horizon]            steps per realization, default 64
 * @param {number} [cfg.realizationCount]   default 300
 * @param {object} [cfg.specs]              override defaultInstrumentSpecs()
 * @returns {Array<object>}                 candidates: { id, reward, risk, downside, worstLoss }
 */
export function instrumentCandidates(cfg = {}) {
  const initialPrice = cfg.initialPrice != null ? cfg.initialPrice : 100;
  const horizon = cfg.horizon != null ? cfg.horizon : 64;
  const realizationCount = cfg.realizationCount != null ? cfg.realizationCount : 300;
  const specs = cfg.specs || defaultInstrumentSpecs(initialPrice);

  const seriesFor = (underlying, seed) => gbmSeries({
    initialPrice: underlying.initialPrice,
    mu: underlying.mu,
    sigma: underlying.sigma,
    length: horizon,
    seed,
  }).series;

  const single = Object.entries(specs).map(([id, spec]) => instrumentReturnDistribution({
    id,
    makeInstrument: spec.make,
    makeSeries: (seed) => seriesFor(spec.underlying, seed),
    length: horizon,
    realizationCount,
    seedBase: 500000 + id.length * 1000,
  }));

  // A mixed strategy: half growth, half yield, by initial value. Drives both
  // legs from independent realizations per seed and blends total value.
  const mixedReturns = [];
  for (let r = 0; r < realizationCount; r += 1) {
    const gSeries = seriesFor(specs.growth.underlying, 700000 + r);
    const ySeries = seriesFor(specs.yield.underlying, 800000 + r);
    const { totalReturn } = mixReturns([
      { instrument: specs.growth.make(gSeries), qty: 0.5 },
      { instrument: specs.yield.make(ySeries), qty: 0.5 },
    ], { length: horizon });
    mixedReturns.push(totalReturn);
  }
  const mixedStats = rewardRiskOf(mixedReturns);
  const mixed = { id: 'mixed', ...mixedStats, returns: mixedReturns };

  return [...single, mixed].map((c) => ({
    id: c.id,
    reward: c.reward,
    risk: c.risk,
    downside: c.downside,
    worstLoss: c.worstLoss,
  }));
}

/**
 * Run the full evaluation.
 *
 * @param {object} cfg
 * @param {Array<{name: string, kind: string, params: object}>} cfg.presets
 * @param {(preset: object, overrides: object) => {series: number[], meta: object}} cfg.generate
 * @param {object} [cfg.forecastEval]       forwarded to evalTableOverPresets
 * @param {object} [cfg.instruments]        forwarded to instrumentCandidates
 * @param {number[]} [cfg.tolerances]       volatility-tolerance grid
 * @returns {{ forecastTable: Array<object>, candidates: Array<object>, frontier: Array<object> }}
 */
export function runEvaluation(cfg) {
  const forecastTable = evalTableOverPresets(cfg.presets, cfg.generate, cfg.forecastEval || {});
  const candidates = instrumentCandidates(cfg.instruments || {});
  const frontier = toleranceFrontier({ candidates, tolerances: cfg.tolerances });
  return { forecastTable, candidates, frontier };
}

/**
 * Render the evaluation result as plain-text tables for a report / CLI.
 *
 * @param {{forecastTable: Array<object>, candidates: Array<object>, frontier: Array<object>}} result
 * @returns {string}
 */
export function renderEvaluationText(result) {
  const f = (x, d = 4) => (x == null || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d));
  const lines = [];

  lines.push('# Forecast-evaluation table (ensemble vs known process)');
  lines.push('preset                 kind        fitMu     fitSigma  CRPS      cov90  cov50  pitKS   relErr');
  for (const r of result.forecastTable) {
    lines.push(
      `${r.name.padEnd(22)} ${r.kind.padEnd(11)} ${f(r.fittedMu, 5).padStart(8)} `
      + `${f(r.fittedSigma, 4).padStart(8)} ${f(r.crps, 3).padStart(8)} `
      + `${f(r.coverage90, 2).padStart(5)} ${f(r.coverage50, 2).padStart(5)} `
      + `${f(r.pitKs, 3).padStart(6)} ${f(r.relPointError, 3).padStart(7)}`,
    );
  }

  lines.push('');
  lines.push('# Instrument candidates (reward vs risk)');
  lines.push('id          reward    risk      downside  worstLoss');
  for (const c of result.candidates) {
    lines.push(
      `${c.id.padEnd(11)} ${f(c.reward).padStart(8)} ${f(c.risk).padStart(8)} `
      + `${f(c.downside).padStart(8)} ${f(c.worstLoss).padStart(9)}`,
    );
  }

  lines.push('');
  lines.push('# Risk/reward frontier over volatility tolerance');
  lines.push('tolerance  lambda    chosen      reward    risk');
  for (const row of result.frontier) {
    lines.push(
      `${f(row.tolerance, 2).padStart(9)} ${f(row.lambda, 3).padStart(8)} `
      + `${row.chosenId.padEnd(11)} ${f(row.reward).padStart(8)} ${f(row.risk).padStart(8)}`,
    );
  }

  return lines.join('\n') + '\n';
}
