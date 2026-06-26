/**
 * analyzer (orient phase, programmatic form).
 *
 * Consumes oracle-watcher opportunities plus the current portfolio and a
 * price window; scores each opportunity risk-adjusted, and decides on a
 * candidate rebalance (a proposed target weight for the top asset) that the
 * forecaster will then project and the planner will formalize.
 *
 * Per the role brief: read-only; score over rank; no-action is a valid
 * outcome. The analyzer does NOT propose transactions directly — it emits a
 * scored recommendation and a candidate target weight; the planner is the
 * role that turns that into bounded funds-flow steps.
 */

import { navOf } from './rebalance.js';

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
 * @param {object} [config]
 * @param {number} [config.k]                  number of recommendations (default 3)
 * @param {number} [config.scoreFloor]         minimum top score to propose (default 0.05)
 * @param {number} [config.reversionStrength]  how far toward/away from the asset to tilt per unit deviation (default 0.5)
 * @param {number} [config.maxTargetWeight]    cap on the proposed asset weight (default 0.6)
 * @returns {AnalyzerResult}
 */
export function analyze(input, config = {}) {
  const k = config.k != null ? config.k : 3;
  const scoreFloor = config.scoreFloor != null ? config.scoreFloor : 0.05;
  const reversionStrength = config.reversionStrength != null ? config.reversionStrength : 0.5;
  const maxTargetWeight = config.maxTargetWeight != null ? config.maxTargetWeight : 0.6;

  const opportunities = input.opportunities || [];
  const readings = input.readings || [];
  const prices = input.prices || (readings.length ? readings[readings.length - 1].prices : {});
  const nav = navOf(input.portfolio, prices);

  const scores = [];
  for (const opp of opportunities) {
    const vol = realizedVolatility(readings, opp.asset);
    // Mean-reversion edge: a down-deviation is a buy edge, an up-deviation a
    // trim edge. Expected edge magnitude is a fraction of the deviation.
    const deviation = opp.deviationBps / 10000; // fractional
    const expectedEdge = -deviation * reversionStrength; // down dev (neg) -> positive buy edge
    // Current concentration of this asset.
    const heldValue = (input.portfolio.balances[opp.asset] || 0) * (prices[opp.asset] || 0);
    const concentration = nav > 0 ? heldValue / nav : 0;
    // Risk-adjusted: edge per unit volatility, penalized for adding to an
    // already-concentrated position (only when the edge says buy).
    const riskDenom = vol + 0.01;
    const concentrationPenalty = expectedEdge > 0 ? concentration * 0.25 : 0;
    const score = expectedEdge / riskDenom - concentrationPenalty;
    scores.push({
      asset: opp.asset,
      score,
      expectedEdge,
      volatility: vol,
      concentration,
      direction: opp.direction,
      deviationBps: opp.deviationBps,
      rationale:
        `${opp.asset}: ${opp.direction === 'down' ? 'price dipped' : 'price lifted'} `
        + `${opp.deviationBps.toFixed(0)}bps; realized vol ${(vol * 100).toFixed(2)}%; `
        + `current weight ${(concentration * 100).toFixed(1)}%; `
        + `risk-adjusted score ${score.toFixed(4)}.`,
    });
  }
  scores.sort((a, b) => b.score - a.score);
  const recommendations = scores.slice(0, k);

  const top = scores[0];
  if (!top || top.score < scoreFloor) {
    return {
      trigger: opportunities[0] || null,
      scores,
      recommendations,
      next_action: 'no-action',
    };
  }

  // Candidate target weight for the top asset: tilt its current weight by the
  // expected edge, capped. A positive edge raises the weight (buy the dip);
  // a negative edge would have lost the scoreFloor gate already.
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
