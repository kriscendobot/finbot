/**
 * Profile-driven allocation: how the planner consumes a persisted
 * volatility-tolerance profile.
 *
 * The elicitation harness (`@finbot/simulator/elicitation` + `profile-store`)
 * yields a calibrated `tau`. This module is the seam where the *decide* phase
 * reads that `tau` and lets it pick among candidate allocations on the
 * risk/reward frontier, then formalizes the choice through the existing
 * `plan()` — leaving the planner's deterministic, hashable core untouched.
 *
 * A candidate is an allocation the analyzer/forecaster put on the table,
 * annotated with its (reward, risk) and the target weights that realize it:
 *
 *   { id, reward, risk, targetWeights: Record<string, number> }
 *
 * `chooseStrategy` (mean-variance certainty-equivalent under `tau`) selects the
 * one the user's appetite implies; `plan()` turns its weights into bounded
 * funds-flow steps.
 */

import { chooseStrategy } from '@finbot/simulator/risk-reward';

import { plan } from './planner.js';

/**
 * Read the calibrated tolerance out of a profile (or accept a bare number).
 *
 * @param {object | number} profileOrTau   a persisted profile, or a tau directly
 * @returns {number}                        tau in [0,1]
 * @throws {Error} if neither a profile.tau nor a finite number is available
 */
export function toleranceFromProfile(profileOrTau) {
  if (typeof profileOrTau === 'number' && Number.isFinite(profileOrTau)) {
    return profileOrTau;
  }
  if (profileOrTau && Number.isFinite(profileOrTau.tau)) {
    return profileOrTau.tau;
  }
  throw new Error('toleranceFromProfile: need a profile with a numeric tau, or a tau');
}

/**
 * Select the allocation a profile's appetite implies.
 *
 * @param {object} input
 * @param {object} [input.profile]      a persisted volatility profile
 * @param {number} [input.tolerance]    a tau directly (overrides profile)
 * @param {Array<{id: string, reward: number, risk: number, targetWeights: Record<string, number>}>} input.candidates
 * @returns {{tolerance: number, chosen: object, scored: Array<object>}}
 */
export function selectAllocationForProfile(input) {
  const candidates = input.candidates || [];
  if (candidates.length === 0) throw new Error('selectAllocationForProfile: no candidates');
  const tolerance = input.tolerance != null
    ? toleranceFromProfile(input.tolerance)
    : toleranceFromProfile(input.profile);
  const { chosen, scored } = chooseStrategy(candidates, tolerance);
  return { tolerance, chosen, scored };
}

/**
 * Produce a rebalance proposal driven by a user's volatility profile: choose
 * the allocation the appetite implies, then formalize it through `plan()`.
 *
 * @param {object} input
 * @param {object} [input.profile]      a persisted volatility profile
 * @param {number} [input.tolerance]    a tau directly (overrides profile)
 * @param {Array<object>} input.candidates  allocation candidates (with targetWeights)
 * @param {object} input.portfolio      current snapshot (see planner.plan)
 * @param {Record<string, number>} input.prices
 * @param {object} [input.bounds]
 * @param {string[]} [input.cited_forecasts]
 * @param {string[]} [input.cited_analyses]
 * @returns {object}                    a planner Proposal, plus { tolerance, chosenAllocationId }
 */
export function planForProfile(input) {
  const { tolerance, chosen, scored } = selectAllocationForProfile(input);
  const proposal = plan({
    portfolio: input.portfolio,
    prices: input.prices,
    targetWeights: chosen.targetWeights,
    bounds: input.bounds,
    cited_forecasts: input.cited_forecasts,
    cited_analyses: input.cited_analyses,
  });
  return {
    ...proposal,
    tolerance,
    chosenAllocationId: chosen.id,
    scoredAllocations: scored,
  };
}
