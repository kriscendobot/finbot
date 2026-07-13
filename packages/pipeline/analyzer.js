/**
 * analyzer (orient phase, programmatic form).
 *
 * Consumes oracle-watcher opportunities plus the current portfolio and a
 * price window; scores each candidate risk-adjusted, and decides on a
 * candidate rebalance (a target allocation) that the forecaster will then
 * project and the planner will formalize.
 *
 * Three signals feed each candidate's score:
 *
 *   - **Price signal.** A mean-reversion edge from the oracle deviation: a
 *     down-deviation is a buy edge, an up-deviation a trim edge, divided by
 *     realized volatility (the price risk denominator).
 *   - **Carry signal.** A yield/APR-bearing instrument's expected carry over
 *     the analysis horizon, also divided by the price-risk denominator, so a
 *     high-APR low-volatility leg outscores a high-APR high-volatility one.
 *     This is the "weigh APR vs price risk" the multi-instrument cut needs.
 *   - **Correlation penalty.** Adding to a position that is highly correlated
 *     with the rest of the held book buys little diversification, so the
 *     candidate's correlation-weighted exposure to the current cluster is
 *     subtracted from its score.
 *
 * The risk denominator each signal is divided by is the realized (window-averaged)
volatility by default. When a GARCH regime descriptor is supplied
(`config.regimeVol`), the analyzer fits it from the same window and blends the
fitted surface's terminal *conditional* volatility into that denominator, so the
score reads the CURRENT regime — an elevated, persistent conditional vol
discounts a candidate; the calm after a storm does not over-penalize a real edge
the stale window average would.

In single-position mode (the default, `maxPositions: 1`) the analyzer emits
 * one target weight for the top asset, exactly as before. In multi-position
 * mode it spreads a bounded risk budget across the top-scoring candidates —
 * including registry yield legs that did not themselves deviate — so a
 * >=3-instrument allocation can flow end to end. When no instrument registry
 * and no correlation spec are supplied, the carry and correlation terms are
 * zero and the single-position path is byte-for-byte the prior behaviour.
 *
 * Per the role brief: read-only; score over rank; no-action is a valid
 * outcome. The analyzer does NOT propose transactions directly — it emits a
 * scored recommendation and candidate target weights; the planner is the
 * role that turns that into bounded funds-flow steps.
 */

import { aprOf } from '@finbot/simulator/yield-accrual';
import { conditionalVolFromPriceHistory } from '@finbot/simulator/garch';

import { navOf } from './rebalance.js';

/**
 * Build a correlation lookup `(a, b) => rho` from a sparse pair spec, a
 * nested map, or a full matrix (with an asset order). Returns 0 for any pair
 * the spec does not cover, and 1 on the diagonal. A null spec yields the
 * all-zero lookup, so a caller with no correlation knowledge pays nothing.
 *
 * @param {number[][] | Record<string, any> | undefined | null} spec
 * @param {string[]} assetOrder   anchors a matrix spec's row/column indices
 * @returns {(a: string, b: string) => number}
 */
export function correlationLookup(spec, assetOrder) {
  if (spec == null) return () => 0;
  if (Array.isArray(spec)) {
    const idx = new Map(assetOrder.map((a, i) => [a, i]));
    return (a, b) => {
      if (a === b) return 1;
      const i = idx.get(a);
      const j = idx.get(b);
      if (i == null || j == null) return 0;
      const row = spec[i];
      return row && row[j] != null ? row[j] : 0;
    };
  }
  const m = new Map();
  for (const [key, val] of Object.entries(spec)) {
    if (val != null && typeof val === 'object') {
      for (const [b, rho] of Object.entries(val)) {
        m.set(`${key}|${b}`, rho);
        m.set(`${b}|${key}`, rho);
      }
    } else {
      const [a, b] = key.split(':');
      if (a && b) {
        m.set(`${a}|${b}`, val);
        m.set(`${b}|${a}`, val);
      }
    }
  }
  return (a, b) => {
    if (a === b) return 1;
    const v = m.get(`${a}|${b}`);
    return v != null ? v : 0;
  };
}

/**
 * @typedef {object} AnalyzerResult
 * @property {object} trigger              the opportunity that prompted this
 * @property {Array<object>} scores        per-asset risk-adjusted scores, desc
 * @property {Array<object>} recommendations  top-K with rationale
 * @property {'propose-rebalance' | 'no-action'} next_action
 * @property {Record<string, number>} [targetWeights]  candidate allocation (when proposing)
 */

/**
 * Realized volatility (stddev of per-step log returns) of an asset across
 * the reading window. Used as the risk denominator in the score.
 *
 * @param {Array<{ prices: Record<string, number> }>} readings
 * @param {string} asset
 * @returns {number}
 */
export function realizedVolatility(readings, asset) {
  const rets = [];
  for (let i = 1; i < readings.length; i += 1) {
    const a = readings[i - 1].prices[asset];
    const b = readings[i].prices[asset];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const variance = rets.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

/**
 * Score and recommend.
 *
 * @param {object} input
 * @param {import('./oracle-watcher.js').Opportunity[]} input.opportunities
 * @param {Array<{ t: number, prices: Record<string, number> }>} input.readings
 * @param {{ cash: number, balances: Record<string, number> }} input.portfolio  current snapshot
 * @param {Record<string, number>} input.prices  latest price book
 * @param {Record<string, object>} [input.instruments]   asset -> live instrument descriptor (carry/APR source)
 * @param {number[][] | Record<string, any>} [input.correlations]  correlation spec for the cluster penalty
 * @param {object} [config]
 * @param {number} [config.k]                  number of recommendations (default 3)
 * @param {number} [config.scoreFloor]         minimum score to propose / include (default 0.05)
 * @param {number} [config.reversionStrength]  how far toward/away from the asset to tilt per unit deviation (default 0.5)
 * @param {number} [config.maxTargetWeight]    cap on any single asset's weight (default 0.6)
 * @param {number} [config.maxPositions]       positions in the target allocation (default 1 = single-asset, legacy)
 * @param {number} [config.maxTotalWeight]     total risk-asset budget in multi-position mode (default 0.8)
 * @param {number} [config.carryHorizonTicks]  ticks over which APR carry accrues for scoring (default window length)
 * @param {number} [config.ticksPerYear]       APR -> per-tick conversion base (default 365)
 * @param {number} [config.correlationPenalty] strength of the correlated-cluster penalty (default 0.5)
 * @param {object} [config.regimeVol]          GARCH descriptor WITHOUT data (e.g. `{ kind: 'garch' }` or
 *   `{ kind: 'garch', estimate: 'mle' }`) fit from the window to read the current conditional-vol regime; absent → realized vol only
 * @param {number} [config.regimeWeight]       blend of conditional vol into the risk denominator when a regime read exists (default 0.5)
 * @returns {AnalyzerResult}
 */
export function analyze(input, config = {}) {
  const k = config.k != null ? config.k : 3;
  const scoreFloor = config.scoreFloor != null ? config.scoreFloor : 0.05;
  const reversionStrength = config.reversionStrength != null ? config.reversionStrength : 0.5;
  const maxTargetWeight = config.maxTargetWeight != null ? config.maxTargetWeight : 0.6;
  const maxPositions = config.maxPositions != null ? config.maxPositions : 1;
  const maxTotalWeight = config.maxTotalWeight != null ? config.maxTotalWeight : 0.8;
  const ticksPerYear = config.ticksPerYear != null ? config.ticksPerYear : 365;
  const correlationPenaltyStrength = config.correlationPenalty != null ? config.correlationPenalty : 0.5;
  // Regime read (opt-in). `config.regimeVol` is a GARCH descriptor WITHOUT data
  // (e.g. `{ kind: 'garch' }` or `{ kind: 'garch', estimate: 'mle' }`), fit from
  // this window here; its terminal conditional vol replaces part of the
  // window-averaged realized vol in the risk denominator so the score reads the
  // CURRENT regime, not the window average. Absent → the risk denominator is
  // byte-for-byte the prior realized-vol behaviour.
  const regimeWeight = config.regimeWeight != null ? config.regimeWeight : 0.5;

  const opportunities = input.opportunities || [];
  const readings = input.readings || [];
  const prices = input.prices || (readings.length ? readings[readings.length - 1].prices : {});
  const instruments = input.instruments || {};
  const nav = navOf(input.portfolio, prices);
  const carryHorizon = config.carryHorizonTicks != null
    ? config.carryHorizonTicks
    : Math.max(1, readings.length - 1);

  const assetOrder = Object.keys(prices);
  const corr = correlationLookup(input.correlations, assetOrder);

  // Fit the volatility regime from the observed window when asked. A degenerate
  // window (constant prices → non-stationary params) or too few frames must not
  // sink the analysis — fall back to the all-realized-vol denominator (empty map).
  let regime = {};
  if (config.regimeVol) {
    const frames = readings.map((r) => r.prices).filter((p) => p && typeof p === 'object');
    if (frames.length >= 2) {
      try {
        regime = conditionalVolFromPriceHistory(frames, config.regimeVol);
      } catch (_err) {
        regime = {};
      }
    }
  }

  // Correlation-weighted exposure of `asset` to the rest of the held book:
  // the sum of each other held position's weight times its positive
  // correlation with `asset`. High exposure means adding here concentrates
  // an already-correlated cluster and buys little diversification.
  const clusterExposureOf = (asset) => {
    let exposure = 0;
    for (const [held, qty] of Object.entries(input.portfolio.balances || {})) {
      if (held === asset) continue;
      const heldValue = (qty || 0) * (prices[held] || 0);
      if (heldValue <= 0) continue;
      const rho = corr(asset, held);
      if (rho > 0) exposure += rho * (nav > 0 ? heldValue / nav : 0);
    }
    return exposure;
  };

  // Candidate set: every oracle deviation, plus (in multi-position mode) any
  // registry yield leg that did not itself deviate — its carry alone can earn
  // it a place in the allocation.
  const candidates = [];
  const seen = new Set();
  for (const opp of opportunities) {
    candidates.push({ asset: opp.asset, deviationBps: opp.deviationBps, direction: opp.direction });
    seen.add(opp.asset);
  }
  if (maxPositions > 1) {
    for (const asset of Object.keys(instruments).sort()) {
      if (seen.has(asset)) continue;
      const descriptor = instruments[asset];
      if (descriptor && descriptor.type === 'yield' && (prices[asset] || 0) > 0) {
        candidates.push({ asset, deviationBps: 0, direction: 'flat', carryOnly: true });
        seen.add(asset);
      }
    }
  }

  const scores = [];
  for (const cand of candidates) {
    const vol = realizedVolatility(readings, cand.asset);
    // Mean-reversion edge: a down-deviation is a buy edge, an up-deviation a
    // trim edge. Expected edge magnitude is a fraction of the deviation.
    const deviation = cand.deviationBps / 10000; // fractional
    const expectedEdge = -deviation * reversionStrength; // down dev (neg) -> positive buy edge
    // Carry: the candidate's APR over the analysis horizon. Zero for a
    // growth leg or a leg with no registry descriptor.
    const apr = aprOf(instruments[cand.asset]);
    const carry = apr * (carryHorizon / ticksPerYear);
    // Current concentration of this asset.
    const heldValue = (input.portfolio.balances[cand.asset] || 0) * (prices[cand.asset] || 0);
    const concentration = nav > 0 ? heldValue / nav : 0;
    // Regime-aware risk: when a GARCH regime read is available for this asset,
    // blend its terminal CONDITIONAL vol into the risk denominator. In a
    // high-vol regime (recent shocks that persist) the conditional vol sits
    // above the window-averaged realized vol, so the score is discounted; in
    // the calm after a storm it sits below, so a real edge is not over-penalized
    // by a stale window. Persistence rides along in the record as the regime's
    // decay speed. With no regime read, riskVol === vol (legacy).
    const reg = regime[cand.asset];
    const riskVol = reg
      ? (1 - regimeWeight) * vol + regimeWeight * reg.conditionalVol
      : vol;
    // Risk-adjusted: (price edge + carry) per unit volatility, less a penalty
    // for adding to an already-concentrated or already-correlated position.
    const riskDenom = riskVol + 0.01;
    const buying = expectedEdge > 0 || carry > 0;
    const concentrationPenalty = buying ? concentration * 0.25 : 0;
    const clusterExposure = clusterExposureOf(cand.asset);
    const correlationPenalty = buying ? correlationPenaltyStrength * clusterExposure : 0;
    const score = (expectedEdge + carry) / riskDenom - concentrationPenalty - correlationPenalty;
    scores.push({
      asset: cand.asset,
      score,
      expectedEdge,
      carry,
      apr,
      volatility: vol,
      riskVol,
      conditionalVol: reg ? reg.conditionalVol : null,
      persistence: reg ? reg.persistence : null,
      concentration,
      clusterExposure,
      correlationPenalty,
      direction: cand.direction,
      deviationBps: cand.deviationBps,
      rationale:
        `${cand.asset}: ${cand.carryOnly ? 'carry leg' : (cand.direction === 'down' ? 'price dipped' : 'price lifted')} `
        + `${cand.deviationBps.toFixed(0)}bps; realized vol ${(vol * 100).toFixed(2)}%; `
        + (reg
          ? `conditional vol ${(reg.conditionalVol * 100).toFixed(2)}% (persistence ${reg.persistence.toFixed(3)}); `
            + `risk vol ${(riskVol * 100).toFixed(2)}%; `
          : '')
        + `APR ${(apr * 100).toFixed(2)}%; current weight ${(concentration * 100).toFixed(1)}%; `
        + `cluster exposure ${(clusterExposure * 100).toFixed(1)}%; `
        + `risk-adjusted score ${score.toFixed(4)}.`,
    });
  }
  scores.sort((a, b) => b.score - a.score);
  const recommendations = scores.slice(0, k);

  const noAction = (trigger) => ({
    trigger: trigger || null,
    scores,
    recommendations,
    next_action: 'no-action',
  });

  // ----- single-position mode (default; legacy behaviour) -----
  if (maxPositions <= 1) {
    const top = scores[0];
    if (!top || top.score < scoreFloor) return noAction(opportunities[0]);
    // Candidate target weight for the top asset: tilt its current weight by
    // the expected edge, capped. A positive edge raises the weight (buy the
    // dip); a negative edge would have lost the scoreFloor gate already.
    const currentWeight = top.concentration;
    let targetWeight = currentWeight + Math.max(0, top.expectedEdge) * 4; // amplify the small fractional edge
    if (targetWeight > maxTargetWeight) targetWeight = maxTargetWeight;
    if (targetWeight < 0) targetWeight = 0;
    return {
      trigger: opportunities[0],
      scores,
      recommendations,
      next_action: 'propose-rebalance',
      targetWeights: { [top.asset]: targetWeight },
    };
  }

  // ----- multi-position mode -----
  // Take the top-scoring candidates that clear the floor and carry a positive
  // expected reward, then split a bounded risk budget across them in
  // proportion to score (each leg still capped at maxTargetWeight). The
  // residual stays in cash.
  const eligible = scores
    .filter((s) => s.score >= scoreFloor && s.score > 0 && (s.expectedEdge > 0 || s.carry > 0))
    .slice(0, maxPositions);
  if (eligible.length === 0) return noAction(opportunities[0]);

  const scoreSum = eligible.reduce((acc, s) => acc + s.score, 0);
  /** @type {Record<string, number>} */
  const targetWeights = {};
  for (const s of eligible) {
    let weight = scoreSum > 0 ? maxTotalWeight * (s.score / scoreSum) : maxTotalWeight / eligible.length;
    if (weight > maxTargetWeight) weight = maxTargetWeight;
    if (weight > 0) targetWeights[s.asset] = weight;
  }

  return {
    trigger: opportunities[0] || { asset: eligible[0].asset, deviationBps: 0, direction: 'flat' },
    scores,
    recommendations,
    next_action: 'propose-rebalance',
    targetWeights,
  };
}
