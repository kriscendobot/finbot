/**
 * planner (decide phase, ymax-shaped).
 *
 * Given the current portfolio, a candidate target allocation (from the
 * analyzer), and a forecast projection (from the forecaster), the planner
 * emits a *proposal*: an ordered list of bounded funds-flow steps, a content
 * hash over those steps, and citations of the forecast and analysis that
 * justified them. It does not sign or send anything; the proposal goes to
 * the auditor and then (with authorization, never in this pipeline) the
 * executor.
 *
 * Deterministic given inputs: two planner runs over identical inputs produce
 * an identical `proposal_hash`. That determinism is exactly the property the
 * auditor's reproducibility invariant relies on.
 */

import crypto from 'node:crypto';

import { deriveSteps, navOf } from './rebalance.js';

/**
 * Canonicalize the plan body and hash it. Only the fields that define the
 * plan's effect participate, in a stable key order, so the hash is stable
 * across runs and recomputable by the auditor.
 *
 * @param {Array<object>} steps
 * @returns {string} sha256 hex
 */
export function hashProposal(steps) {
  const canonical = steps.map((s) => ({
    source: s.source,
    dest: s.dest,
    side: s.side,
    asset: s.asset,
    qty: round(s.qty),
    price: round(s.price),
    notional: round(s.notional),
  }));
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function round(x) {
  // Stable rounding so floating noise does not perturb the hash.
  return Math.round(x * 1e8) / 1e8;
}

/**
 * @typedef {object} Proposal
 * @property {string} proposal_hash
 * @property {Array<object>} steps
 * @property {string[]} cited_forecasts
 * @property {string[]} cited_analyses
 * @property {Record<string, number>} targetWeights
 * @property {object} bounds
 * @property {boolean} clamped         a risk bound clamped at least one step
 * @property {number} nav
 * @property {string} dry_run_summary
 * @property {object} [breach]         present when a bound made the plan empty/partial
 */

/**
 * Produce a rebalance proposal.
 *
 * @param {object} input
 * @param {{ cash: number, balances: Record<string, number>, quoteCurrency?: string }} input.portfolio  current snapshot
 * @param {Record<string, number>} input.prices
 * @param {Record<string, number>} input.targetWeights        from the analyzer
 * @param {object} [input.bounds]                              risk bounds (see deriveSteps)
 * @param {string[]} [input.cited_forecasts]                   forecast entry ids/paths
 * @param {string[]} [input.cited_analyses]                    analysis entry ids/paths
 * @returns {Proposal}
 */
export function plan(input) {
  const bounds = input.bounds || {};
  const nav = navOf(input.portfolio, input.prices);
  const { steps, clamped } = deriveSteps(input.portfolio, input.prices, input.targetWeights, bounds);
  const proposal_hash = hashProposal(steps);

  const cited_forecasts = input.cited_forecasts || [];
  const cited_analyses = input.cited_analyses || [];

  const dry_run_summary = steps.length === 0
    ? `No steps: portfolio already within tolerance of target ${JSON.stringify(input.targetWeights)}.`
    : steps
        .map((s) => `${s.side} ${s.qty.toFixed(4)} ${s.asset} @ ${s.price.toFixed(4)} `
          + `(${s.notional.toFixed(2)} ${input.portfolio.quoteCurrency || 'USDC'}${s.estGas ? `, gas ${s.estGas}` : ''})`)
        .join('; ');

  /** @type {Proposal} */
  const proposal = {
    proposal_hash,
    steps,
    cited_forecasts,
    cited_analyses,
    targetWeights: input.targetWeights,
    bounds,
    clamped,
    nav,
    dry_run_summary,
  };
  return proposal;
}
