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
import { stepHasRealRoute } from './substrates.js';
import { worstAssetPersistence, persistenceStress } from './forecaster.js';

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
 * @param {number} [config.regimeTailBump]           max extra floor (as a fraction of NAV) a fully
 *   persistent vol regime adds to `tailFloorPct` (default 0 → OFF, gate unchanged). The forecast's
 *   per-instrument GARCH persistence tightens the tail-risk gate: a highly persistent (clustering,
 *   slow-decaying) regime has fatter downside tails than its p05 point estimate alone conveys, so a
 *   persistent regime must clear a *higher* downside floor. Inert without a `forecast.volFit`.
 * @param {number} [config.regimePersistenceLo]      persistence at/below which the bump is 0 (default 0.70)
 * @param {number} [config.regimePersistenceHi]      persistence at/above which the bump is full (default 0.98)
 * @param {number} [config.regimeTailFloorCap]       the regime-tightened floor never exceeds this * NAV (default 0.98)
 * @param {number} [config.stalenessWindowTicks]     cited readings no older than this (default 5)
 * @param {number} [config.dataSufficiencyMinCoverage]  minimum forecast coverage ratio (observed returns per
 *   projected tick) the gate requires (default 0 -> OFF: the invariant is not even emitted, so the verdict
 *   is byte-identical to before). When armed, a forecast whose `dataSufficiency.coverageRatio` falls below
 *   it — that is, it projects further than its observed window justifies — fails the gate, and so does a
 *   forecast carrying no measurable descriptor: an armed gate with no evidence fails CLOSED rather than
 *   approving vacuously. An unusable threshold (non-finite or negative) arms the gate and fails it closed
 *   too, so a malformed knob can never silently degrade to no gate at all.
 * @returns {AuditVerdict}
 */
export function audit(input, config = {}) {
  const maxStepPct = config.maxStepPct != null ? config.maxStepPct : 0.25;
  const maxDayPct = config.maxDayPct != null ? config.maxDayPct : 0.50;
  const concentrationCapPct = config.concentrationCapPct != null ? config.concentrationCapPct : 0.80;
  const tailFloorPct = config.tailFloorPct != null ? config.tailFloorPct : 0.80;
  const regimeTailBump = config.regimeTailBump != null ? config.regimeTailBump : 0;
  const regimePersistenceLo = config.regimePersistenceLo != null ? config.regimePersistenceLo : 0.70;
  const regimePersistenceHi = config.regimePersistenceHi != null ? config.regimePersistenceHi : 0.98;
  const regimeTailFloorCap = config.regimeTailFloorCap != null ? config.regimeTailFloorCap : 0.98;
  const stalenessWindowTicks = config.stalenessWindowTicks != null ? config.stalenessWindowTicks : 5;
  const dataSufficiencyMinCoverage = config.dataSufficiencyMinCoverage != null
    ? Number(config.dataSufficiencyMinCoverage) : 0;

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
  // A persistent vol regime (per-instrument GARCH persistence in the forecast's
  // volFit) tightens the floor: high persistence clusters shocks and fattens the
  // downside beyond what the p05 point estimate alone shows, so a persistent
  // regime must clear a higher floor. `regimeTailBump` = 0 (default) or a plain
  // forecast without a volFit leaves the floor at `tailFloorPct` exactly.
  const regime = regimeTailFloor({
    forecast, tailFloorPct, regimeTailBump,
    regimePersistenceLo, regimePersistenceHi, regimeTailFloorCap,
  });
  const floor = regime.floorPct * nav;
  const tailPass = forecast != null && forecast.p05Equity >= floor - 1e-6;
  results.push({
    name: 'tail-risk-floor',
    pass: tailPass,
    detail: forecast == null
      ? 'no forecast supplied'
      : `forecast p05 terminal equity ${forecast.p05Equity.toFixed(2)} vs floor ${floor.toFixed(2)} (${(regime.floorPct * 100).toFixed(1)}% of NAV${regime.tightened
          ? `; regime-tightened from ${(tailFloorPct * 100).toFixed(1)}% on persistence ${regime.persistence.toFixed(3)} of ${regime.worstAsset}`
          : ''})`,
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

  // 6. Place/route reachability. On the sim substrate each step is
  // self-contained (asset, qty, price) and the venue is implicit, so the
  // invariant is structurally satisfied. On a real substrate (Path A/C) every
  // step must carry a resolved place/route; a step still missing its venue
  // mapping (or naming an unknown place) is not reachable and fails the gate.
  // A route that only awaits deploy-config detail (pool addresses, GMP
  // channels) is reachable: filling it is a later, separately authorized step.
  const realRouteSteps = proposal.steps.filter((s) => s.route && typeof s.route === 'object');
  let routePass = true;
  let routeDetail = 'sim venue: each step is self-contained (asset, qty, price); venue is implicit';
  if (realRouteSteps.length > 0) {
    const unreachable = realRouteSteps.filter((s) => !stepHasRealRoute(s));
    routePass = unreachable.length === 0;
    routeDetail = routePass
      ? `all ${realRouteSteps.length} step(s) carry a reachable ${proposal.substrate || 'substrate'} place/route`
      : `${unreachable.length} step(s) have an unresolved place/route (unmapped or unknown venue)`;
  }
  results.push({ name: 'place-route-reachability', pass: routePass, detail: routeDetail });

  // 7. Forecast data-sufficiency (opt-in gate). A projection whose horizon
  // outruns its observed window is extrapolating past its evidence; when the
  // operator sets a minimum coverage ratio, the forecast must clear it before
  // the gate approves live execution — the pre-execution sibling of pricing
  // freshness (a forecast can be fresh yet thin). Off by default
  // (`dataSufficiencyMinCoverage` 0) -> the invariant is not emitted, so the
  // verdict is byte-identical to before.
  //
  // Armed, the gate fails CLOSED. A forecast carrying no measurable
  // `dataSufficiency` descriptor — the forecaster's report left off upstream, or
  // a malformed descriptor from a foreign producer (the LLM-facing
  // `audit_proposal` tool and the executor's fire-time re-audit both pass a
  // caller-supplied forecast) — cannot be SHOWN to clear the requirement, so it
  // fails rather than passing vacuously: absence of evidence is not evidence of
  // sufficiency, and this verdict is a precondition for irreversible action.
  // The sibling tail-risk floor already fails closed on a missing forecast.
  // An unusable threshold fails closed on the same reasoning, so an operator who
  // asked for a gate never silently gets none.
  //
  // The threshold is compared against the descriptor's own `coverageRatio`,
  // never against a producer-chosen verdict — the gate must not trust a
  // judgement made by the thing it gates. The 1e-12 slack absorbs the
  // descriptor's `round12` quantization, so a coverage that exactly meets the
  // requirement is not rejected by a trailing-digit artifact.
  const minCoverageUsable = Number.isFinite(dataSufficiencyMinCoverage) && dataSufficiencyMinCoverage >= 0;
  if (!minCoverageUsable || dataSufficiencyMinCoverage > 0) {
    const dataSufficiency = forecast && forecast.dataSufficiency;
    const coverageRatio = dataSufficiency ? Number(dataSufficiency.coverageRatio) : NaN;
    let sufficiencyPass = false;
    let sufficiencyDetail;
    if (!minCoverageUsable) {
      sufficiencyDetail = `required coverage ${String(config.dataSufficiencyMinCoverage)} is not a finite `
        + 'non-negative number; the gate cannot be evaluated (fails closed)';
    } else if (!Number.isFinite(coverageRatio)) {
      sufficiencyDetail = 'forecast carries no measurable data-sufficiency descriptor vs required '
        + `${dataSufficiencyMinCoverage.toFixed(3)}; the gate cannot be evaluated (fails closed)`;
    } else {
      sufficiencyPass = coverageRatio >= dataSufficiencyMinCoverage - 1e-12;
      const observedReturns = Number.isFinite(dataSufficiency.historyReturns) ? dataSufficiency.historyReturns : '?';
      const projectedTicks = Number.isFinite(dataSufficiency.horizon) ? dataSufficiency.horizon : '?';
      const onAsset = typeof dataSufficiency.worstAsset === 'string' ? ` on ${dataSufficiency.worstAsset}` : '';
      sufficiencyDetail = `forecast coverage ${coverageRatio.toFixed(3)}${onAsset} `
        + `(${observedReturns} observed return(s) / ${projectedTicks}-tick horizon) `
        + `vs required ${dataSufficiencyMinCoverage.toFixed(3)}`;
    }
    results.push({ name: 'forecast-data-sufficiency', pass: sufficiencyPass, detail: sufficiencyDetail });
  }

  const failed = results.filter((r) => !r.pass).map((r) => r.name);
  return {
    proposal_hash: proposal.proposal_hash,
    verdict: failed.length === 0 ? 'approved' : 'rejected',
    invariant_results: results,
    failed_invariants: failed,
  };
}

/**
 * Compute the (possibly regime-tightened) tail-risk floor as a fraction of NAV.
 *
 * The forecast's `volFit.assets[asset].persistence` (α+β, the GARCH clustering
 * coefficient) is the signal: a highly persistent regime holds an elevated
 * conditional variance for many ticks, so a shock this cycle compounds into a
 * deeper drawdown than an equal-variance-but-mean-reverting regime would. The
 * forecast's p05 already prices *some* of this (the ensemble projects under the
 * fitted surface), but a single-window persistence estimate is noisy and a
 * point p05 gives no margin for that estimation error — so a persistent regime
 * must clear extra downside headroom before the gate approves live execution.
 *
 * The bump is a deterministic linear ramp of the WORST asset's persistence from
 * `lo` (no bump) to `hi` (full `regimeTailBump`), added to `tailFloorPct` and
 * capped at `regimeTailFloorCap`. Deterministic, bounded, and — when
 * `regimeTailBump` is 0 or the forecast carries no volFit — exactly the
 * unadjusted `tailFloorPct`, so the default gate is byte-identical to before.
 *
 * @returns {{ floorPct: number, tightened: boolean, persistence: number, worstAsset: string|null }}
 */
function regimeTailFloor({
  forecast, tailFloorPct, regimeTailBump,
  regimePersistenceLo, regimePersistenceHi, regimeTailFloorCap,
}) {
  const base = { floorPct: tailFloorPct, tightened: false, persistence: 0, worstAsset: null };
  if (!(regimeTailBump > 0)) return base;

  // The portfolio is only as safe as its most persistent instrument's regime;
  // key off the worst (max-persistence) fitted asset — the SAME worst-asset the
  // forecaster's regime-horizon stretch keys off, via the shared helper.
  const { worstAsset, persistence } = worstAssetPersistence(forecast && forecast.volFit);
  if (worstAsset == null) return base;

  const stress = persistenceStress(persistence, regimePersistenceLo, regimePersistenceHi);
  if (stress <= 0) {
    return { floorPct: tailFloorPct, tightened: false, persistence, worstAsset };
  }
  const bumped = Math.min(regimeTailFloorCap, tailFloorPct + regimeTailBump * stress);
  return {
    floorPct: bumped,
    tightened: bumped > tailFloorPct + 1e-12,
    persistence,
    worstAsset,
  };
}
