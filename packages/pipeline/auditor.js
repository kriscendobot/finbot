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

/** @import { DataSufficiency, ForecastProjection } from './forecaster.js' */
/** @import { Proposal } from './planner.js' */
/** @import { Opportunity } from './oracle-watcher.js' */

/**
 * @typedef {object} AuditVerdict
 * @property {string} proposal_hash
 * @property {'approved' | 'rejected'} verdict
 * @property {Array<{ name: string, pass: boolean, detail: string }>} invariant_results
 * @property {string[]} failed_invariants
 */

/**
 * @param {object} input
 * @param {Proposal} input.proposal
 * @param {ForecastProjection|null|undefined} input.forecast   the projection that justified the
 *   proposal. Declared possibly-absent and read as possibly-malformed on purpose: `audit()` is
 *   reached with a CALLER-supplied forecast (the LLM-facing `audit_proposal` tool, the executor's
 *   fire-time re-audit), so it is untrusted input and every fail-closed branch below is reachable.
 * @param {{ cash: number, balances: Record<string, number> }} input.portfolio  pre-trade snapshot
 * @param {Record<string, number>} input.prices
 * @param {number} input.currentTick                 freshness clock
 * @param {Opportunity[]} [input.oracleReadings]   cited readings (carry observedAtTick)
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
 *   below reads it as such. `coverageGateArmed` decides OFF-vs-armed and `coverageThresholdUsable` decides
 *   whether an armed gate can evaluate the threshold at all; both are exported, and their docstrings carry
 *   the rationale. Armed, the gate fails CLOSED — see `dataSufficiencyGate`, and
 *   `skills/pre-execution-audit/SKILL.md` § 7 for the canonical statement.
 * @returns {AuditVerdict}
 */
export function audit(input, config = {}) {
  // Every caller-supplied knob is snapshotted with ONE read, then defaulted:
  // `config.x != null ? config.x : d` reads twice, so an accessor `config` that
  // answers `0.8` and then `0` would set a floor the gate never agreed to. One
  // read per knob, uniformly — the same discipline the forecast's own fields get
  // below, on the same untrusted `audit_proposal` / fire-time re-audit surface.
  const withDefault = (value, fallback) => (value != null ? value : fallback);
  const maxStepPct = withDefault(config.maxStepPct, 0.25);
  const maxDayPct = withDefault(config.maxDayPct, 0.50);
  const concentrationCapPct = withDefault(config.concentrationCapPct, 0.80);
  const tailFloorPct = withDefault(config.tailFloorPct, 0.80);
  const regimeTailBump = withDefault(config.regimeTailBump, 0);
  const regimePersistenceLo = withDefault(config.regimePersistenceLo, 0.70);
  const regimePersistenceHi = withDefault(config.regimePersistenceHi, 0.98);
  const regimeTailFloorCap = withDefault(config.regimeTailFloorCap, 0.98);
  const stalenessWindowTicks = withDefault(config.stalenessWindowTicks, 5);
  // The threshold's arming and usability tests are the exported predicates, so
  // the CLI's flag validation and the cycle's evidence auto-enable cannot drift
  // from the gate they claim to mirror.
  let rawMinCoverage;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(config, 'dataSufficiencyMinCoverage');
    rawMinCoverage = descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : descriptor ? Symbol('unreadable data-sufficiency threshold') : undefined;
  } catch (_error) {
    rawMinCoverage = Symbol('unreadable data-sufficiency threshold');
  }
  const dataSufficiencyMinCoverage = typeof rawMinCoverage === 'number' ? rawMinCoverage : NaN;
  const minCoverageUsable = coverageThresholdUsable(rawMinCoverage);
  const dataSufficiencyArmed = coverageGateArmed(rawMinCoverage);

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
      // The asset name is caller-supplied on the same untrusted surface the
      // descriptor's `worstAsset` arrives on, and lands in the same recorded
      // detail line — so it takes the same sanitizer. A family, not a special case.
      riskDetail = `${sanitizedLabelOr(s.asset, 'an unnamed asset')} weight ${(weight * 100).toFixed(1)}% exceeds concentration cap ${(concentrationCapPct * 100).toFixed(0)}%`;
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
          ? `; regime-tightened from ${(tailFloorPct * 100).toFixed(1)}% on persistence ${regime.persistence.toFixed(3)} of ${sanitizedLabel(regime.worstAsset)}`
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
      ? `all ${realRouteSteps.length} step(s) carry a reachable ${sanitizedLabelOr(proposal.substrate, 'substrate')} place/route`
      : `${unreachable.length} step(s) have an unresolved place/route (unmapped or unknown venue)`;
  }
  results.push({ name: 'place-route-reachability', pass: routePass, detail: routeDetail });

  // 7. Forecast data-sufficiency (opt-in gate). A projection whose horizon
  // outruns its observed window is extrapolating past its evidence. Off by
  // default -> the invariant is not emitted, so the verdict is byte-identical to
  // before; armed, it fails CLOSED and decides on coverage it RECOMPUTES from
  // the descriptor's counts. The rationale, each unevaluable case, and the limit
  // of what the recompute buys are in the `@param` above and in
  // `dataSufficiencyGate`; the canonical statement is
  // skills/pre-execution-audit/SKILL.md § 7.
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
 * Can the data-sufficiency gate EVALUATE this threshold?
 *
 * Read strictly, never through `Number()`: the whole falsy family (`''`, `'  '`,
 * `false`, `[]`) coerces to 0, which is exactly the OFF value — a coercing read
 * hands an operator who asked for a gate no gate at all — and `Number()` on a
 * Symbol or a hostile `valueOf` throws out of the auditor instead of returning a
 * verdict. A positive threshold BELOW the descriptor's own 12-decimal resolution
 * is unusable too: every coverage would quantize to at-or-above it, so the gate
 * would be armed and vacuous, the same "armed and isn't" mode a coerced
 * threshold produces. (That boundary is where `round12` rounds up, just above
 * 5e-13, not 1e-12 itself.)
 *
 * Exported as the ONE definition of the predicate, for the same reason `round12`
 * is the one quantizer it is built on: `bin/finbot-ooda` rejects a threshold the
 * gate could not evaluate, and `ooda-cycle.js` enables the forecaster's evidence
 * for a threshold that arms it. A copy in either place drifts, and both
 * directions of drift are silent — relax it and the CLI exits 2 on values the
 * gate accepts; tighten it and the CLI accepts a value that arms the gate and
 * fails it closed, which is the disarm-by-typo the validation exists to prevent.
 *
 * @param {unknown} value   `config.dataSufficiencyMinCoverage`, as supplied
 * @returns {boolean}
 */
export function coverageThresholdUsable(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && (value === 0 || round12(value) > 0);
}

/**
 * Is the data-sufficiency gate ARMED by this threshold?
 *
 * Absent, `null`, or the number 0 is OFF: the invariant is not even emitted, so
 * the verdict is byte-identical to before. Anything else arms it — including a
 * threshold the gate cannot evaluate, which arms it and fails it CLOSED rather
 * than coercing onto the OFF value, so a malformed knob can never silently
 * degrade to no gate at all.
 *
 * @param {unknown} value   `config.dataSufficiencyMinCoverage`, as supplied
 * @returns {boolean}
 */
export function coverageGateArmed(value) {
  if (value == null) return false;
  if (!coverageThresholdUsable(value)) return true;
  return value > 0;
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
 * The descriptor's own `value` is tested with `Object.hasOwn`, never `'value' in
 * descriptor`: a descriptor is an ordinary object inheriting from
 * `Object.prototype`, and `in` walks that chain, so a single polluted
 * `Object.prototype.value` would make every ACCESSOR descriptor — which carries
 * no own `value` — answer with the polluted value. That is the same substitution
 * this function exists to refuse, reintroduced by the ownness check itself.
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
  } catch (_error) {
    return undefined; // a hostile proxy trap owes a verdict, not an exception
  }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
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
    return sanitizeLabel(typeof value === 'string' ? JSON.stringify(value) : String(value));
  } catch (_error) {
    return '(unprintable)';
  }
}

/**
 * Make an untrusted, caller-supplied identifier safe to interpolate into a
 * verdict detail line. The verdict is recorded into the journal and re-read
 * (the CLI report, `auditBody`), so an asset name carrying a line break could
 * forge invariant lines the auditor never emitted.
 *
 * @param {unknown} value
 * @returns {string|null}  null when the value is not a string at all
 */
function sanitizedLabel(value) {
  if (typeof value !== 'string') return null;
  return sanitizeLabel(value);
}

/**
 * `sanitizedLabel` with a fallback for the non-string case, for the detail lines that
 * want a word there rather than `null`.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function sanitizedLabelOr(value, fallback) {
  const label = sanitizedLabel(value);
  return label != null && label !== '' ? label : fallback;
}

/**
 * The label cap, in CODE POINTS (see `sanitizeLabel`). Exported alongside the
 * sanitizer for the same reason the sanitizer is exported: a module that records
 * one of these labels needs the bound to size its field and to tell a truncated
 * label from one that genuinely ends in `...`.
 */
export const MAX_LABEL_CODE_POINTS = 48;

/**
 * Rewrite every character that could restructure the record to `?`, and cap the
 * label's length. Exported because the same discipline binds every module that
 * RECORDS one of these labels, not just the one that mints the verdict: the CLI
 * report re-prints `dataSufficiency.worstAsset` from the same untrusted
 * descriptor, and a value one module sanitizes before recording must be
 * sanitized by every module that records it.
 *
 * The scrubbed class is every code point that a line-oriented or bidirectional
 * reader treats as structure, not text: C0 and DEL, the C1 block (U+0085 NEL and
 * U+009B CSI reach a TTY), the Unicode line terminators U+2028 / U+2029 (line
 * breaks to any Unicode-aware splitter, and NOT escaped by `JSON.stringify`),
 * the bidi overrides U+202A-U+202E / U+2066-U+2069, which can visually reorder a
 * verdict without changing a byte of it, and the SURROGATE range U+D800-U+DFFF.
 *
 * The surrogate clause is what makes the well-formedness claim below true of the
 * INPUT, not just of this function's own truncation. The string iterator yields
 * an unpaired surrogate as a lone code point, so a caller-supplied
 * `worstAsset: 'AT\uD83DOM'` would otherwise pass through unchanged: the
 * journal's UTF-8 writer degrades it to U+FFFD while `JSON.stringify` emits
 * `"AT\ud83dOM"` — two readers, divergent bytes, which is exactly the hazard
 * cited for the truncation. A well-formed astral pair is unaffected: the
 * iterator yields it as one code point at or above U+10000, and only an
 * UNPAIRED unit ever surfaces in the surrogate range.
 *
 * Truncation is by CODE POINT, matching the iteration: `slice` is code-unit
 * indexed, so capping there would split an astral pair and emit exactly such a
 * lone surrogate.
 *
 * The output is at most `MAX_LABEL_CODE_POINTS + 3` code points — the cap plus
 * the `...` truncation marker — which is why that constant is exported: a
 * co-recorder cannot size the field, or tell a truncation from a label that
 * really ends in an ellipsis, without it.
 *
 * @param {string} text
 * @returns {string}  at most `MAX_LABEL_CODE_POINTS + 3` code points, always
 *   well-formed UTF-16, carrying no structural code point
 */
export function sanitizeLabel(text) {
  const printable = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    const structural = code < 0x20
      || (code >= 0x7f && code <= 0x9f)
      || code === 0x2028 || code === 0x2029
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
      || (code >= 0xd800 && code <= 0xdfff);
    printable.push(structural ? '?' : character);
    if (printable.length > MAX_LABEL_CODE_POINTS) {
      return `${printable.slice(0, MAX_LABEL_CODE_POINTS).join('')}...`;
    }
  }
  return printable.join('');
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
 * Every read inside is already individually guarded — `readOwn` catches its own
 * proxy trap, and `finiteNumber` / `wholeCount` / `sanitizedLabel` are total over
 * every value — so there is no outer `try` here: a throw escaping this function
 * would be an auditor bug, and swallowing it behind "carries no measurable
 * descriptor" would report that bug as the applicant's fault.
 *
 * The failure is NAMED rather than collapsed to one null, because the two states
 * are different artifacts: a descriptor that cannot be read is the forecast's
 * fault, while a forecast whose OWN horizon is not a tick count is not a
 * statement about the descriptor at all — and this is the one invariant an
 * operator debugs under time pressure.
 *
 * @param {unknown} forecast   untrusted, caller-supplied
 * @returns {{ snapshot: (DataSufficiency & { coverageRatio: number, historyFrames: number,
 *   historyReturns: number, horizon: number, forecastHorizon: number })|null, reason: string|null }}
 *   `snapshot` null with a `reason` naming the field that failed.
 */
function readDataSufficiency(forecast) {
  const raw = readOwn(forecast, 'dataSufficiency');
  const forecastHorizon = wholeCount(readOwn(forecast, 'horizon'));
  if (forecastHorizon == null) {
    return {
      snapshot: null,
      reason: "the forecast's own horizon is absent or is not a whole tick count, so a "
        + 'data-sufficiency descriptor cannot be checked against it',
    };
  }
  if (raw == null || typeof raw !== 'object') {
    return { snapshot: null, reason: 'forecast carries no data-sufficiency descriptor' };
  }
  const coverageRatio = finiteNumber(readOwn(raw, 'coverageRatio'));
  const historyReturns = wholeCount(readOwn(raw, 'historyReturns'));
  const historyFrames = wholeCount(readOwn(raw, 'historyFrames'));
  const horizon = wholeCount(readOwn(raw, 'horizon'));
  const worstAsset = sanitizedLabel(readOwn(raw, 'worstAsset'));
  if (coverageRatio == null || coverageRatio < 0) {
    return {
      snapshot: null,
      reason: "the descriptor's coverageRatio is not a finite non-negative number",
    };
  }
  if (historyReturns == null || historyFrames == null || horizon == null) {
    return {
      snapshot: null,
      reason: "the descriptor's counts are not whole, non-negative frame/return/tick counts",
    };
  }
  return {
    snapshot: {
      coverageRatio, historyReturns, historyFrames, horizon, worstAsset, forecastHorizon,
    },
    reason: null,
  };
}

/**
 * The forecast-data-sufficiency invariant's result: does the projection's
 * observed window justify how far it projects?
 *
 * Every branch but the last fails closed, because each names a state in which
 * the gate cannot SHOW the forecast clears the requirement: an unusable
 * threshold, no readable descriptor (which includes a forecast whose own horizon
 * is unreadable), a descriptor whose horizon contradicts the forecast carrying
 * it, a descriptor whose counts refute each other, or one whose reported ratio
 * contradicts those counts. A gate that refuses ABSENT evidence must refuse
 * CONTRADICTORY evidence at least as firmly; the two are the same state — the
 * gate cannot show the requirement is met — and only one of them looks like a
 * measurement. Both comparisons are quantized to the descriptor's 12 decimals so
 * a coverage that exactly meets its requirement is not rejected by a
 * trailing-digit artifact, and so a threshold below the descriptor's own
 * resolution cannot be cleared by a coverage that rounds to zero.
 *
 * There is no unconditional pass. A ZERO-tick horizon under an armed gate is
 * measured like any other: it recomputes to coverage 0, which clears no positive
 * requirement. "It cannot outrun a window it never used" is true and beside the
 * point — the descriptor's horizon and the forecast's horizon are both fields of
 * the SAME caller-supplied object, so a zero corroborated only by its own
 * neighbour is an assertion, not evidence, and a hand-built `{ horizon: 0 }`
 * forecast would otherwise clear a demand for full coverage having simulated
 * nothing. A zero-tick projection is absence of evidence, and absence of
 * evidence is not evidence of sufficiency.
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
        + 'number, or is a positive one that quantizes to zero at the descriptor\'s 12-decimal '
        + 'resolution; the gate cannot be evaluated (fails closed)',
    };
  }
  const required = formatCoverage(minCoverage);
  const { snapshot, reason } = readDataSufficiency(forecast);
  if (snapshot == null) {
    return {
      pass: false,
      detail: `no measurable data-sufficiency evidence (${reason}) vs required `
        + `${required}; the gate cannot be evaluated (fails closed)`,
    };
  }
  const {
    coverageRatio, historyReturns, historyFrames, horizon, worstAsset, forecastHorizon,
  } = snapshot;
  // Same emptiness test `sanitizedLabelOr` applies: an empty label is not a name, and
  // would leave a dangling ` on ` in the record.
  const onAsset = worstAsset != null && worstAsset !== '' ? ` on ${worstAsset}` : '';
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
      detail: `data-sufficiency descriptor claims coverage ${formatCoverage(coverageRatio)}${onAsset} but its `
        + `own counts ${evidence} recompute to ${formatCoverage(recomputed)}; the gate cannot be evaluated `
        + '(fails closed)',
    };
  }
  return {
    pass: round12(recomputed) >= round12(minCoverage),
    detail: `forecast coverage ${formatCoverage(recomputed)}${onAsset} ${evidence} vs required ${required}`,
  };
}

/**
 * Print a coverage ratio at a resolution that can still tell it apart from the
 * OFF value. A flat `toFixed(3)` renders an armed `1e-12` requirement as
 * `required 0.000` — a REJECT whose own justification reads as satisfied, and
 * whose threshold is indistinguishable from the 0 that means "no gate at all".
 * The detail line IS the evidence for refusing irreversible action, so below the
 * three-decimal resolution it switches to exponential rather than lying.
 *
 * Exported for the reason `round12` and `sanitizeLabel` are: the CLI report
 * re-prints the same coverage from the same descriptor, so it is a RECORDER too,
 * and a figure written in two places is formatted by one formatter. A second,
 * coarser rule there (a flat `toFixed(2)`) would print a passing `0.002`
 * coverage as `0.00` — the same "reads as the OFF value" lie this function
 * exists to refuse, reintroduced one module over.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatCoverage(value) {
  if (value !== 0 && Math.abs(value) < 5e-4) return value.toExponential(3);
  return value.toFixed(3);
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
  //
  // `volFit` is read through `readOwn`, like every other field of this untrusted
  // forecast: a plain `forecast.volFit` would run an own accessor inside
  // `audit()` — and this call precedes every fail-closed branch below, so a
  // throwing getter would abort the audit with no verdict at all, the one
  // outcome `readOwn` exists to prevent. Own-only for the same reason too: an
  // inherited `volFit` is regime evidence the producer never supplied, and it
  // would silently move the floor this gate enforces.
  const { worstAsset, persistence } = worstAssetPersistence(readOwn(forecast, 'volFit'));
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
