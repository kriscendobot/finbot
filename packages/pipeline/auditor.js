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

/** @import { ForecastProjection } from './forecaster.js' */

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
 * @param {ForecastProjection|null|undefined} input.forecast   the projection that justified the
 *   proposal. Declared possibly-absent and read as possibly-malformed on purpose: `audit()` is
 *   reached with a CALLER-supplied forecast (the LLM-facing `audit_proposal` tool, the executor's
 *   fire-time re-audit), so it is untrusted input and every fail-closed branch below is reachable.
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
 *   projected tick) the gate requires. Absent, or the number 0, is OFF: the invariant is not even emitted,
 *   so the verdict is byte-identical to before. When armed, a forecast whose coverage — RECOMPUTED from the
 *   descriptor's own counts, never read off its reported ratio — falls below the requirement fails the gate,
 *   and so does a forecast carrying no measurable descriptor: an armed gate with no evidence fails CLOSED
 *   rather than approving vacuously. Only a `number` is honored: any other type (`''`, `false`, `[]`, `'1'`,
 *   a Symbol) is an unusable threshold, as is a non-finite or negative number or a positive one below the
 *   descriptor's own 1e-12 resolution (which no coverage could fail), and an unusable threshold
 *   arms the gate and fails it closed rather than coercing onto the OFF value — a malformed knob can never
 *   silently degrade to no gate at all.
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
  // Read the gate's threshold STRICTLY, never through `Number()`: the whole
  // falsy family (`''`, `'  '`, `false`, `[]`, `null`-ish objects) coerces to 0,
  // which is exactly the OFF value — a coercing read hands an operator who asked
  // for a gate no gate at all, and `Number()` on a Symbol or a hostile `valueOf`
  // throws out of the auditor instead of returning a verdict. A non-number is an
  // unusable threshold: it ARMS the gate and fails it closed (below).
  const rawMinCoverage = config.dataSufficiencyMinCoverage;
  const dataSufficiencyMinCoverage = typeof rawMinCoverage === 'number' ? rawMinCoverage : NaN;
  // A positive threshold BELOW the descriptor's own 12-decimal resolution is
  // unusable too: every coverage would quantize to at-or-above it, so the gate
  // would be armed and vacuous — the same "armed and isn't" mode a coerced
  // threshold produces.
  const minCoverageUsable = Number.isFinite(dataSufficiencyMinCoverage)
    && dataSufficiencyMinCoverage >= 0
    && (dataSufficiencyMinCoverage === 0 || round12(dataSufficiencyMinCoverage) > 0);
  const dataSufficiencyArmed = rawMinCoverage != null
    && (!minCoverageUsable || dataSufficiencyMinCoverage > 0);

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
  // Armed, the gate fails CLOSED (see the `@param` above for each unevaluable
  // case): absence of evidence is not evidence of sufficiency, and this verdict
  // is a precondition for irreversible action. What is worth stating beside the
  // call rather than in the signature is WHOSE arithmetic decides: the gate
  // recomputes coverage from the descriptor's primitive counts and refuses a
  // descriptor whose reported ratio — or horizon — contradicts them, exactly as
  // invariant 4 recomputes `proposal_hash` instead of reading it. A ratio is a
  // judgement made by the thing being gated; the counts are the evidence.
  if (dataSufficiencyArmed) {
    results.push({
      name: 'forecast-data-sufficiency',
      ...dataSufficiencyGate({
        forecast, minCoverage: dataSufficiencyMinCoverage, minCoverageUsable, rawMinCoverage,
      }),
    });
  }

  const failed = results.filter((r) => !r.pass).map((r) => r.name);
  return {
    proposal_hash: proposal.proposal_hash,
    verdict: failed.length === 0 ? 'approved' : 'rejected',
    invariant_results: results,
    failed_invariants: failed,
  };
}

/** A finite `number`, or null. Type-checked, never coerced. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The descriptor's own quantization (mirrors forecaster.js `round12`), so the
 *  gate's recompute compares like with like on both sides. */
function round12(x) {
  return Number.isFinite(x) ? Number(x.toFixed(12)) : x;
}

/** Name an unusable threshold in the verdict without letting a hostile
 *  `toString` throw out of the auditor. */
function describeThreshold(value) {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch (_err) {
    return '(unprintable)';
  }
}

/**
 * Snapshot the untrusted data-sufficiency descriptor into plain finite numbers,
 * reading each field EXACTLY ONCE so the verdict and the detail line that cites
 * it can never quote different values (a getter that answers differently on a
 * second read would otherwise produce an audit record citing evidence the gate
 * never saw). A hostile getter that throws owes the caller a verdict, not an
 * exception out of `audit()`, so the whole read is guarded.
 *
 * @param {ForecastProjection|null|undefined} forecast
 * @returns {{ coverageRatio: number, historyReturns: number, horizon: number,
 *   worstAsset: string|null, forecastHorizon: number|null } | null}  null when the descriptor is
 *   absent, not an object, or missing any of the three numbers the gate needs.
 */
function readDataSufficiency(forecast) {
  try {
    if (forecast == null || typeof forecast !== 'object') return null;
    const raw = forecast.dataSufficiency;
    const forecastHorizon = finiteNumber(forecast.horizon);
    if (raw == null || typeof raw !== 'object') return null;
    const coverageRatio = finiteNumber(raw.coverageRatio);
    const historyReturns = finiteNumber(raw.historyReturns);
    const horizon = finiteNumber(raw.horizon);
    const worstAsset = typeof raw.worstAsset === 'string' ? raw.worstAsset : null;
    if (coverageRatio == null || historyReturns == null || horizon == null) return null;
    if (historyReturns < 0 || horizon < 0) return null;
    return { coverageRatio, historyReturns, horizon, worstAsset, forecastHorizon };
  } catch (_err) {
    return null;
  }
}

/**
 * The forecast-data-sufficiency invariant's result: does the projection's
 * observed window justify how far it projects?
 *
 * Every branch but the last two fails closed, because each names a state in
 * which the gate cannot SHOW the forecast clears the requirement: an unusable
 * threshold, no readable descriptor, a descriptor whose horizon contradicts the
 * forecast carrying it, or a descriptor whose reported ratio contradicts its own
 * counts. Both comparisons are quantized to the descriptor's 12 decimals so a
 * coverage that exactly meets its requirement is not rejected by a trailing-digit
 * artifact, and so a threshold below the descriptor's own resolution cannot be
 * cleared by a coverage that rounds to zero.
 *
 * @param {object} args
 * @param {ForecastProjection|null|undefined} args.forecast   untrusted, caller-supplied
 * @param {number} args.minCoverage        the threshold, NaN when unusable
 * @param {boolean} args.minCoverageUsable
 * @param {unknown} args.rawMinCoverage    as supplied, for the unusable-threshold detail
 * @returns {{ pass: boolean, detail: string }}
 */
function dataSufficiencyGate({ forecast, minCoverage, minCoverageUsable, rawMinCoverage }) {
  if (!minCoverageUsable) {
    return {
      pass: false,
      detail: `required coverage ${describeThreshold(rawMinCoverage)} is not a finite non-negative `
        + 'number at or above the descriptor\'s 1e-12 resolution; the gate cannot be evaluated '
        + '(fails closed)',
    };
  }
  const required = minCoverage.toFixed(3);
  const descriptor = readDataSufficiency(forecast);
  if (descriptor == null) {
    return {
      pass: false,
      detail: 'forecast carries no measurable data-sufficiency descriptor vs required '
        + `${required}; the gate cannot be evaluated (fails closed)`,
    };
  }
  const { coverageRatio, historyReturns, horizon, worstAsset, forecastHorizon } = descriptor;
  const onAsset = worstAsset != null ? ` on ${worstAsset}` : '';
  const evidence = `(${historyReturns} observed return(s) / ${horizon}-tick horizon)`;
  if (forecastHorizon != null && forecastHorizon !== horizon) {
    return {
      pass: false,
      detail: `data-sufficiency descriptor ${evidence} contradicts the forecast's own `
        + `${forecastHorizon}-tick horizon; the gate cannot be evaluated (fails closed)`,
    };
  }
  const recomputed = horizon > 0 ? round12(historyReturns / horizon) : 0;
  if (round12(recomputed) !== round12(coverageRatio)) {
    return {
      pass: false,
      detail: `data-sufficiency descriptor claims coverage ${coverageRatio.toFixed(3)}${onAsset} but its `
        + `own counts ${evidence} recompute to ${recomputed.toFixed(3)}; the gate cannot be evaluated `
        + '(fails closed)',
    };
  }
  if (horizon === 0) {
    // Nothing measured is not the same as measured-and-insufficient: a projection
    // of zero ticks cannot outrun its window, however thin the window is.
    return {
      pass: true,
      detail: `forecast projects 0 ticks${onAsset} ${evidence}, so it cannot outrun its observed `
        + `window vs required ${required}`,
    };
  }
  return {
    pass: round12(recomputed) >= round12(minCoverage),
    detail: `forecast coverage ${recomputed.toFixed(3)}${onAsset} ${evidence} vs required ${required}`,
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
