/**
 * executor (act phase) — dry-run only in this pipeline.
 *
 * The executor is the ONLY role vended the wallet capability, and only in
 * `--live` mode after an auditor signoff and explicit authorization. This
 * pipeline never authorizes live; the executor here runs strictly in
 * `--dry-run`, simulating each step against a *clone* of the portfolio so the
 * live world is never mutated, and asserting — through the capability
 * attenuator — that no wallet reference is present in its capability set.
 *
 * Re-runs the audit invariants at fire time (drift guard) before simulating.
 */

import { applyStepsToPortfolio, navOf } from './rebalance.js';
import { runInAttenuatedCompartment } from './cap-attenuation.js';
import { audit as runAudit } from './auditor.js';

/**
 * @typedef {object} ExecutionResult
 * @property {string} proposal_hash
 * @property {'dry-run' | 'live'} mode
 * @property {boolean} walletTouched     ALWAYS false in dry-run; the proof the wallet was never reached
 * @property {Array<object>} steps_attempted
 * @property {Array<object>} steps_completed
 * @property {object|null} failed_step
 * @property {{ cash: number, balances: Record<string, number>, equity: number }} post_execution_balances
 * @property {object} [refusal]          present if the executor refused (e.g. live without authorization)
 * @property {object} fire_time_audit    the re-run audit verdict
 */

/**
 * Execute a proposal in dry-run.
 *
 * @param {object} input
 * @param {import('./planner.js').Proposal} input.proposal
 * @param {import('@finbot/simulator/world').World} input.world      live world (NOT mutated)
 * @param {import('./forecaster.js').ForecastProjection} input.forecast
 * @param {import('./oracle-watcher.js').Opportunity[]} [input.oracleReadings]
 * @param {number} input.currentTick
 * @param {Record<string, unknown>} [input.parentCaps]   orchestrator caps (wallet lives here in live runs)
 * @param {object} [config]
 * @param {'dry-run' | 'live'} [config.mode]              default 'dry-run'
 * @param {boolean} [config.live_authorized]              default false
 * @param {object} [config.auditConfig]
 * @returns {Promise<ExecutionResult>}
 */
export async function execute(input, config = {}) {
  const mode = config.mode || 'dry-run';

  // Refuse to upgrade silently: a live mode without authorization stops here,
  // before any wallet is even attenuated in.
  if (mode === 'live' && config.live_authorized !== true) {
    return {
      proposal_hash: input.proposal.proposal_hash,
      mode,
      walletTouched: false,
      steps_attempted: input.proposal.steps,
      steps_completed: [],
      failed_step: null,
      post_execution_balances: snapshotWithEquity(input.world, input.world.priceFeed.current()),
      refusal: { reason: 'live mode requires live_authorized: true; refusing to read keystore or sign' },
      fire_time_audit: null,
    };
  }

  const prices = input.world.priceFeed.current();

  // Drift guard: re-run the audit invariants at fire time.
  const fireTimeAudit = runAudit(
    {
      proposal: input.proposal,
      forecast: input.forecast,
      portfolio: input.world.portfolio.markToMarket(prices),
      prices,
      currentTick: input.currentTick,
      oracleReadings: input.oracleReadings,
    },
    config.auditConfig || {},
  );

  // Attenuate to the executor's capability set. In dry-run the wallet is
  // NOT vended (LIVE_ONLY_CAPS gated on live === false), so caps.wallet is
  // undefined. We assert exactly that and carry it as the walletTouched proof.
  const live = mode === 'live';
  const result = await runInAttenuatedCompartment({
    role: 'executor',
    parentCaps: input.parentCaps || {},
    live,
    walletRevoke: input.parentCaps && input.parentCaps.__walletRevoke,
    fn: (caps) => {
      const walletPresent = caps.wallet !== undefined;
      if (!live && walletPresent) {
        throw new Error('invariant violated: wallet capability vended to a dry-run executor');
      }

      if (fireTimeAudit.verdict !== 'approved') {
        return {
          walletTouched: walletPresent,
          steps_completed: [],
          failed_step: { reason: `fire-time audit rejected: ${fireTimeAudit.failed_invariants.join(', ')}` },
          post: snapshotWithEquity(input.world, prices),
        };
      }

      // DRY-RUN: simulate against a CLONE so the live world is untouched.
      const sandboxPortfolio = input.world.portfolio.clone();
      const { applied, skipped } = applyStepsToPortfolio(sandboxPortfolio, prices, input.proposal.steps, input.currentTick);
      const post = sandboxPortfolio.markToMarket(prices);
      return {
        // In dry-run, the wallet was never present, so it was never touched.
        walletTouched: live ? walletPresent : false,
        steps_completed: applied.map((s) => ({
          side: s.side, asset: s.asset, qty: s.qty, price: s.executedPrice, notional: s.notional,
          simulated_effect: `${s.side} ${s.qty.toFixed(4)} ${s.asset} -> cash ${post.cash.toFixed(2)}`,
        })),
        failed_step: skipped.length > 0 ? { ...skipped[0] } : null,
        post: { cash: post.cash, balances: post.balances, equity: post.equity },
      };
    },
  });

  return {
    proposal_hash: input.proposal.proposal_hash,
    mode,
    walletTouched: result.walletTouched === true ? true : false,
    steps_attempted: input.proposal.steps,
    steps_completed: result.steps_completed,
    failed_step: result.failed_step,
    post_execution_balances: result.post,
    fire_time_audit: fireTimeAudit,
  };
}

function snapshotWithEquity(world, prices) {
  const snap = world.portfolio.markToMarket(prices);
  return { cash: snap.cash, balances: snap.balances, equity: snap.equity };
}

/** @returns {number} convenience NAV at current prices */
export function currentNav(world) {
  const prices = world.priceFeed.current();
  return navOf(world.portfolio.markToMarket(prices), prices);
}
