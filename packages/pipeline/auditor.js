/**
 * auditor (the pre-execution gate).
 *
 * Reads a planner proposal (by `proposal_hash`) plus the forecast and oracle
 * context that justified it, and verifies the standing invariant set from
 * `skills/pre-execution-audit/SKILL.md` and `roles/auditor/AGENT.md`. If
 * every invariant holds it returns an `approved` verdict naming the same
 * hash; otherwise a `rejected` verdict naming the failed invariants. The
 * verdict is a precondition for a live executor dispatch, never an
 * authorization in itself.
 *
 * The auditor is read-only: it recomputes, it never mutates the proposal.
 */

import { hashProposal } from './planner.js';
import { navOf } from './rebalance.js';

/**
 * @typedef {object} AuditVerdict
 * @property {string} proposal_hash
 * @property {'approved' | 'rejected'} verdict
 * @property {Array<{ name: string, pass: boolean, detail: string }>} invariant_results
 * @property {string[]} failed_invariants
 */

/**
 * @param {object} input
 * @param {import('./planner.js').Proposal} input.proposal
 * @param {import('./forecaster.js').ForecastProjection} input.forecast
 * @param {{ cash: number, balances: Record<string, number> }} input.portfolio  pre-trade snapshot
 * @param {Record<string, number>} input.prices
 * @param {number} input.currentTick                 freshness clock
 * @param {import('./oracle-watcher.js').Opportunity[]} [input.oracleReadings]   cited readings (carry observedAtTick)
 * @param {object} [config]
 * @param {number} [config.maxStepPct]               default 0.25
 * @param {number} [config.maxDayPct]                default 0.50
 * @param {number} [config.concentrationCapPct]      default 0.80
 * @param {number} [config.tailFloorPct]             p05 terminal equity >= this * NAV (default 0.80)
 * @param {number} [config.stalenessWindowTicks]     cited readings no older than this (default 5)
 * @returns {AuditVerdict}
 */
export function audit(input, config = {}) {
  const maxStepPct = config.maxStepPct != null ? config.maxStepPct : 0.25;
  const maxDayPct = config.maxDayPct != null ? config.maxDayPct : 0.50;
  const concentrationCapPct = config.concentrationCapPct != null ? config.concentrationCapPct : 0.80;
  const tailFloorPct = config.tailFloorPct != null ? config.tailFloorPct : 0.80;
  const stalenessWindowTicks = config.stalenessWindowTicks != null ? config.stalenessWindowTicks : 5;

  const { proposal, forecast, prices } = input;
  const nav = navOf(input.portfolio, prices);
  const results = [];

  // 1. Citation completeness.
  const hasSteps = proposal.steps.length > 0;
  const cited = proposal.cited_forecasts.length > 0 && proposal.cited_analyses.length > 0;
  results.push({
    name: 'citation-completeness',
    pass: hasSteps && cited,
    detail: hasSteps
      ? (cited ? 'every plan has a forecast and an analysis citation'
              : 'missing forecast and/or analysis citation')
      : 'plan has no steps to audit',
  });

  // 2. Risk-bound compliance: per-step, cumulative, concentration.
  let cumulative = 0;
  const balances = { ...input.portfolio.balances };
  let cash = input.portfolio.cash;
  let riskPass = true;
  let riskDetail = 'all steps within per-step, per-day, and concentration bounds';
  for (const s of proposal.steps) {
    cumulative += s.notional;
    if (s.notional > maxStepPct * nav + 1e-6) {
      riskPass = false;
      riskDetail = `step notional ${s.notional.toFixed(2)} exceeds per-step cap ${(maxStepPct * nav).toFixed(2)}`;
      break;
    }
    // simulate the step's effect on weight
    if (s.side === 'buy') { balances[s.asset] = (balances[s.asset] || 0) + s.qty; cash -= s.notional; }
    else { balances[s.asset] = (balances[s.asset] || 0) - s.qty; cash += s.notional; }
    const weight = nav > 0 ? ((balances[s.asset] || 0) * s.price) / nav : 0;
    if (weight > concentrationCapPct + 1e-6) {
      riskPass = false;
      riskDetail = `${s.asset} weight ${(weight * 100).toFixed(1)}% exceeds concentration cap ${(concentrationCapPct * 100).toFixed(0)}%`;
      break;
    }
  }
  if (riskPass && cumulative > maxDayPct * nav + 1e-6) {
    riskPass = false;
    riskDetail = `cumulative notional ${cumulative.toFixed(2)} exceeds per-day cap ${(maxDayPct * nav).toFixed(2)}`;
  }
  results.push({ name: 'risk-bound-compliance', pass: riskPass, detail: riskDetail });

  // 3. Tail-risk floor: forecast 5th-percentile terminal equity clears floor.
  const floor = tailFloorPct * nav;
  const tailPass = forecast != null && forecast.p05Equity >= floor - 1e-6;
  results.push({
    name: 'tail-risk-floor',
    pass: tailPass,
    detail: forecast == null
      ? 'no forecast supplied'
      : `forecast p05 terminal equity ${forecast.p05Equity.toFixed(2)} vs floor ${floor.toFixed(2)} (${(tailFloorPct * 100).toFixed(0)}% of NAV)`,
  });

  // 4. Reproducibility: recompute the hash from the steps.
  const recomputed = hashProposal(proposal.steps);
  const reproPass = recomputed === proposal.proposal_hash;
  results.push({
    name: 'reproducibility',
    pass: reproPass,
    detail: reproPass ? 'recomputed hash matches' : `hash mismatch: recomputed ${recomputed.slice(0, 12)} != ${String(proposal.proposal_hash).slice(0, 12)}`,
  });

  // 5. Pricing freshness: cited readings within the staleness window.
  const readings = input.oracleReadings || [];
  let freshPass = true;
  let freshDetail = 'no oracle readings cited (vacuously fresh)';
  if (readings.length > 0) {
    const stale = readings.filter((r) => input.currentTick - r.observedAtTick > stalenessWindowTicks);
    freshPass = stale.length === 0;
    freshDetail = freshPass
      ? `all ${readings.length} cited readings within ${stalenessWindowTicks} ticks`
      : `${stale.length} cited reading(s) older than ${stalenessWindowTicks} ticks`;
  }
  results.push({ name: 'pricing-freshness', pass: freshPass, detail: freshDetail });

  // 6. No off-chain dependencies in the on-chain steps. In the simulator each
  // step references only asset/amount/price; success is determined by the
  // (simulated) venue, not by any off-chain artifact. Structurally satisfied;
  // the real-substrate auditor verifies place/route reachability here.
  results.push({
    name: 'no-offchain-step-deps',
    pass: true,
    detail: 'sim venue: each step is self-contained (asset, qty, price); off-chain artifacts are inputs, not preconditions',
  });

  const failed = results.filter((r) => !r.pass).map((r) => r.name);
  return {
    proposal_hash: proposal.proposal_hash,
    verdict: failed.length === 0 ? 'approved' : 'rejected',
    invariant_results: results,
    failed_invariants: failed,
  };
}
