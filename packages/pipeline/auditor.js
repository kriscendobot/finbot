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
import { worstAssetPersistence, persistenceStress, round12 } from './forecaster.js';

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
 * @param {unknown} [config.dataSufficiencyMinCoverage]  minimum forecast coverage ratio (observed returns per
 *   projected tick) the gate requires. Declared `unknown` because it is caller-supplied and every branch
 *   below reads it as such. Absent, `null`, or the number 0 is OFF: the invariant is not even emitted,
 *   so the verdict is byte-identical to before. When armed, a forecast whose coverage — RECOMPUTED from the
 *   descriptor's own counts, never read off its reported ratio — falls below the requirement fails the gate,
 *   and so does a forecast carrying no measurable descriptor, one whose counts refute each other, and one
 *   whose own `horizon` is absent or unreadable: an armed gate with no evidence, or contradictory evidence,
 *   fails CLOSED rather than approving vacuously. Only a `number` is honored: any other type (`''`, `false`, `[]`, `'1'`,
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
  // The p05 anchor is read as untrusted input like every other field of a
  // caller-supplied forecast: a forecast whose `p05Equity` is absent or not a
  // finite number owes the caller a REJECTING verdict, not a `TypeError` thrown
  // out of `audit()` while formatting the detail line — this same call is the
  // executor's unwrapped fire-time drift guard.
  const p05Equity = readOwnFiniteNumber(forecast, 'p05Equity');
  const tailPass = p05Equity != null && p05Equity >= floor - 1e-6;
  results.push({
    name: 'tail-risk-floor',
    pass: tailPass,
    detail: forecast == null
      ? 'no forecast supplied'
      : p05Equity == null
        ? `forecast carries no finite p05 terminal equity vs floor ${floor.toFixed(2)}`
        : `forecast p05 terminal equity ${p05Equity.toFixed(2)} vs floor ${floor.toFixed(2)} (${(regime.floorPct * 100).toFixed(1)}% of NAV${regime.tightened
          ? `; regime-tightened from ${(tailFloorPct * 100).toFixed(1)}% on persistence ${regime.persistence.toFixed(3)} of ${safeLabel(regime.worstAsset)}`
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
  // is a precondition for irreversible action. WHOSE arithmetic decides is the
  // gate's: it recomputes coverage from the descriptor's primitive counts and
  // refuses a descriptor whose reported ratio — or horizon, or count of returns
  // against frames — contradicts them. A ratio is a judgement made by the thing
  // being gated; the counts are the evidence. Weaker than invariant 4 all the
  // same: that one recomputes from evidence the auditor independently holds,
  // while these counts remain self-reported (see `dataSufficiencyGate`).
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

/**
 * A finite `number`, or null. Type-checked, never coerced.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A whole, non-negative count, or null. A tick or observation count that is
 * fractional (`1e-13` returns over a `1e-13`-tick horizon recomputes to a clean
 * 1.0) is not a count at all, so it is not evidence.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function wholeCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one OWN DATA property of an untrusted object, or `undefined`.
 *
 * Own-only, because an inherited value is not evidence the producer supplied: a
 * single polluted `Object.prototype.dataSufficiency` would otherwise turn "this
 * forecast carries no descriptor, so fail closed" into "this forecast inherits a
 * passing one, so approve" — precisely the substitution a fail-closed gate
 * exists to refuse, and the same own-property discipline the forecaster applies
 * on the producing side. Data-property-only (via the descriptor, never a plain
 * `[[Get]]`), because an own accessor on untrusted input would otherwise run
 * inside `audit()`.
 *
 * @param {unknown} object
 * @param {string} key
 * @returns {unknown}
 */
function readOwn(object, key) {
  if (object == null || typeof object !== 'object') return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (_err) {
    return undefined; // a hostile proxy trap owes a verdict, not an exception
  }
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * `readOwn` narrowed to a finite number.
 *
 * @param {unknown} object
 * @param {string} key
 * @returns {number|null}
 */
function readOwnFiniteNumber(object, key) {
  return finiteNumber(readOwn(object, key));
}

/**
 * Name an unusable threshold in the verdict without letting a hostile
 * `toString` throw out of the auditor, and without letting an unbounded string
 * ride into a verdict another reader parses.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeThreshold(value) {
  try {
    return clampLabel(typeof value === 'string' ? JSON.stringify(value) : String(value));
  } catch (_err) {
    return '(unprintable)';
  }
}

/**
 * Make an untrusted, caller-supplied identifier safe to interpolate into a
 * verdict detail line. The verdict is recorded into the journal and re-read
 * (the CLI report, `auditBody`), so an asset name carrying a newline could
 * forge invariant lines the auditor never emitted. Control characters become
 * `?` and the label is capped.
 *
 * @param {unknown} value
 * @returns {string|null}  null when the value is not a string at all
 */
function safeLabel(value) {
  if (typeof value !== 'string') return null;
  return clampLabel(value);
}

/**
 * @param {string} text
 * @returns {string}
 */
function clampLabel(text) {
  let printable = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    printable += code < 0x20 || code === 0x7f ? '?' : ch;
  }
  return printable.length > 48 ? `${printable.slice(0, 48)}…` : printable;
}

/**
 * Snapshot the untrusted data-sufficiency descriptor into plain numbers,
 * reading each field EXACTLY ONCE, own-data-property only (see `readOwn`), so
 * the verdict and the detail line that cites it can never quote different
 * values and no inherited or computed field can stand in for evidence the
 * producer never supplied.
 *
 * Every count must be a WHOLE, non-negative number: the descriptor's counts are
 * frames and returns, and a fractional pair (`1e-13` returns over a `1e-13`-tick
 * horizon) recomputes to a clean 1.0 while measuring nothing at all. The
 * forecast's OWN horizon is required too, not merely cross-checked when present:
 * an unreadable `forecast.horizon` leaves the gate unable to tell a genuine
 * zero-tick projection from a descriptor asserting one, and that ambiguity must
 * not resolve in the applicant's favour.
 *
 * @param {unknown} forecast   untrusted, caller-supplied
 * @returns {{ coverageRatio: number, historyReturns: number, historyFrames: number,
 *   horizon: number, worstAsset: string|null, forecastHorizon: number } | null}  null when the
 *   descriptor (or the forecast's own horizon) is absent, not an object, or not the whole-count
 *   evidence the gate needs.
 */
function readDataSufficiency(forecast) {
  try {
    const raw = readOwn(forecast, 'dataSufficiency');
    const forecastHorizon = wholeCount(readOwn(forecast, 'horizon'));
    if (raw == null || typeof raw !== 'object') return null;
    const coverageRatio = finiteNumber(readOwn(raw, 'coverageRatio'));
    const historyReturns = wholeCount(readOwn(raw, 'historyReturns'));
    const historyFrames = wholeCount(readOwn(raw, 'historyFrames'));
    const horizon = wholeCount(readOwn(raw, 'horizon'));
    const worstAsset = safeLabel(readOwn(raw, 'worstAsset'));
    if (coverageRatio == null || coverageRatio < 0) return null;
    if (historyReturns == null || historyFrames == null || horizon == null) return null;
    if (forecastHorizon == null) return null;
    return { coverageRatio, historyReturns, historyFrames, horizon, worstAsset, forecastHorizon };
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
 * threshold, no readable descriptor (which now includes a forecast whose own
 * horizon is unreadable), a descriptor whose horizon contradicts the forecast
 * carrying it, a descriptor whose counts refute each other, or one whose
 * reported ratio contradicts those counts. A gate that refuses ABSENT evidence
 * must refuse CONTRADICTORY evidence at least as firmly; the two are the same
 * state — the gate cannot show the requirement is met — and only one of them
 * looks like a measurement. Both comparisons are quantized to the descriptor's
 * 12 decimals so a coverage that exactly meets its requirement is not rejected
 * by a trailing-digit artifact, and so a threshold below the descriptor's own
 * resolution cannot be cleared by a coverage that rounds to zero.
 *
 * The recompute bounds FORGERY, not competence: the counts are still
 * self-reported by the artifact being gated, so an internally consistent
 * fabrication (`1000` returns over a `20`-tick horizon) clears the gate. That is
 * a weaker guarantee than invariant 4's, which recomputes `proposal_hash` from
 * the proposal's own steps — independent evidence the auditor already holds.
 * Here the auditor holds no price window to recount against, so what it can
 * enforce is that the ratio it judges is the ratio the descriptor's own evidence
 * supports. Binding the descriptor to an attested `projectionId` is the way to
 * close the remaining gap; until then, treat this invariant as measuring
 * self-consistency, not provenance.
 *
 * @param {object} args
 * @param {unknown} args.forecast          untrusted, caller-supplied
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
  const {
    coverageRatio, historyReturns, historyFrames, horizon, worstAsset, forecastHorizon,
  } = descriptor;
  const onAsset = worstAsset != null ? ` on ${worstAsset}` : '';
  const evidence = `(${historyReturns} observed return(s) / ${horizon}-tick horizon)`;
  if (forecastHorizon !== horizon) {
    return {
      pass: false,
      detail: `data-sufficiency descriptor ${evidence} contradicts the forecast's own `
        + `${forecastHorizon}-tick horizon; the gate cannot be evaluated (fails closed)`,
    };
  }
  // The producer's own contiguity rule: a return needs two ADJACENT observed
  // frames, so a window of N frames yields at most N-1 returns. A descriptor
  // claiming more returns than its frames can yield refutes itself one field
  // deeper than the ratio does, and the recompute alone would not catch it.
  if (historyReturns > Math.max(0, historyFrames - 1)) {
    return {
      pass: false,
      detail: `data-sufficiency descriptor claims ${historyReturns} observed return(s) from `
        + `${historyFrames} observed frame(s), which cannot yield more than `
        + `${Math.max(0, historyFrames - 1)}; the gate cannot be evaluated (fails closed)`,
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
    // of zero ticks cannot outrun its window, however thin the window is. This is
    // the gate's only unconditional pass, so it is reachable ONLY once the
    // forecast's own horizon has corroborated the zero above — a descriptor
    // asserting "0 ticks" beside a forecast that projects 20 (or beside a
    // forecast whose horizon cannot be read at all) is refuted, never honored.
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
