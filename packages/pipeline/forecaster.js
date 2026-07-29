/**
 * forecaster (orient phase, Monte Carlo via the simulator).
 *
 * Projects a candidate rebalance over a fixed horizon by forking the world
 * into an ensemble of independent stochastic trajectories (the simulator's
 * `forecast()` primitive), applying the proposed rebalance on each child at
 * t=1, and aggregating the terminal-equity distribution into a histogram +
 * quantiles. This is the "meat of the orient phase" the role brief names.
 *
 * Determinism is the contract: same world + target + bounds + horizon +
 * ensembleSize + baseSeed produce a byte-identical histogram, because every
 * child seed is derived from a fixed schedule (baseSeed, baseSeed+1, ...)
 * and the price feed's RNG is the seeded sfc32, never Math.random.
 */

import { createHash } from 'node:crypto';
import { forecast as simForecast } from '@finbot/simulator/forecast';
import { makeVolSurface } from '@finbot/simulator/world';
import { deriveSteps, applyStepsToPortfolio, navOf } from './rebalance.js';

// This module measures caller-supplied oracle frames before the dependency graph
// happens to import a lockdown shim. Capture the primordials used for own-data
// reads now: a later replacement of Object.hasOwn or
// Object.getOwnPropertyDescriptor must not turn an accessor-only price into
// coverage evidence.
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const numberToFixed = Number.prototype.toFixed;
const reflectApply = Reflect.apply;

/**
 * Read an own data property without executing an accessor. An unreadable
 * property is absent evidence.
 *
 * @param {unknown} object
 * @param {string} key
 * @returns {unknown}
 */
function readOwnDataProperty(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  try {
    const descriptor = getOwnPropertyDescriptor(object, key);
    return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch (_error) {
    return undefined;
  }
}

/**
 * Extract the per-tick price frames (`[{ asset: price }, ...]`) an
 * empirical / GARCH fitter wants from an oracle reading window
 * (`[{ t, prices }, ...]`). A reading missing its `prices` map is skipped.
 *
 * @param {Array<{ t?: number, prices?: Record<string, number> }>} readings
 * @returns {Array<Record<string, number>>}
 */
export function priceFramesFromReadings(readings) {
  const frames = [];
  for (const r of readings || []) {
    const prices = readOwnDataProperty(r, 'prices');
    if (prices && typeof prices === 'object') frames.push(prices);
  }
  return frames;
}

/**
 * Preserve a missing price map as a gap for data-sufficiency measurement. The
 * adaptive-vol fitter may discard an unusable reading, but coverage cannot make
 * the two observations on either side of an outage adjacent evidence.
 *
 * @param {Array<{ prices?: Record<string, number> }>} readings
 * @returns {Array<Record<string, number>|null>}
 */
function priceFramesForCoverage(readings) {
  const frames = [];
  for (const reading of readings || []) {
    const prices = readOwnDataProperty(reading, 'prices');
    frames.push(prices && typeof prices === 'object' ? prices : null);
  }
  return frames;
}

/**
 * When the caller asks for an adaptive vol surface, fit one from the observed
 * window and return a forecast world whose price feed carries it, plus a
 * small descriptor of what was fit (for the projection's citation trail).
 * Returns the world unchanged (and a null fit) when adaptive vol is off, the
 * window is too short, the feed cannot host a surface, or the fit is degenerate
 * — so the default path stays byte-identical to the pre-adaptive behaviour.
 *
 * The fit is deterministic (variance targeting over the observed returns; no
 * RNG), so the whole forecast stays reproducible from its seeds.
 *
 * @param {import('@finbot/simulator/world').World} world
 * @param {Array<{ t?: number, prices?: Record<string, number> }>} readings
 * @param {object|undefined} adaptiveVol   a volSurface descriptor WITHOUT data
 *   (e.g. `{ kind: 'garch' }`, `{ kind: 'gjr-garch', alpha, beta }`, or
 *   `{ kind: 'auto-gjr-garch' }`, or `{ kind: 'auto-egarch' }`); its
 *   `history` is filled from the observed window here.
 * @returns {{ world: import('@finbot/simulator/world').World, fit: object|null }}
 */
export function fitForecastWorld(world, readings, adaptiveVol) {
  if (!adaptiveVol) return { world, fit: null };
  const feed = world && world.priceFeed;
  if (!feed || typeof feed.withVolSurface !== 'function') return { world, fit: null };
  const frames = priceFramesFromReadings(readings);
  if (frames.length < 2) return { world, fit: null };
  let surface;
  try {
    surface = makeVolSurface({ ...adaptiveVol, history: frames });
  } catch (_err) {
    // A degenerate window (constant prices → non-stationary params, etc.)
    // must not sink the cycle; fall back to the unadapted world.
    return { world, fit: null };
  }
  if (!surface) return { world, fit: null };
  const fitWorld = { ...world, priceFeed: feed.withVolSurface(surface) };
  const kind = adaptiveVol.kind || 'empirical';
  const fit = { kind, source: 'observed-window', frames: frames.length };
  // Surface a compact, deterministic per-asset summary when the surface can
  // report it (GARCH/GJR expose stats()); it lands in the artifact so the
  // audit's recompute-and-compare and the citation trail can see the regime.
  if (typeof surface.stats === 'function' && typeof surface.has === 'function') {
    const assets = {};
    for (const asset of Object.keys(frames[frames.length - 1])) {
      if (!surface.has(asset)) continue;
      const st = surface.stats(asset);
      assets[asset] = {
        unconditionalVol: round12(st.unconditionalVol),
        sigma0: round12(st.sigma0),
        persistence: round12(st.persistence),
      };
      if (st.gamma != null) assets[asset].gamma = round12(st.gamma);
      if (st.model != null) assets[asset].model = st.model;
      if (st.selection != null) assets[asset].selection = st.selection;
      if (st.selectionMargin != null) assets[asset].selectionMargin = round12(st.selectionMargin);
      if (st.oosQlike != null) {
        assets[asset].oosQlike = Object.freeze(Object.fromEntries(
          Object.entries(st.oosQlike).map(([model, value]) => [model, round12(value)]),
        ));
      }
      // Each per-asset record is frozen HERE, not only the map holding them:
      // `persistence` is the leaf the auditor's regime-tail-floor actually
      // reads, so a freeze that stopped at the container would leave the one
      // field that moves the floor writable after the artifact was hashed.
      Object.freeze(assets[asset]);
    }
    fit.assets = Object.freeze(assets);
  }
  // Frozen for the same reason the data-sufficiency descriptor is: this record
  // is aliased into the hashed `projectionArtifact` and read by the auditor's
  // regime-tail-floor, so hash and evidence must not be able to diverge. The
  // freeze is applied at every depth a consumer reads (the fit, its `assets`
  // map, each per-asset record, and each record's `oosQlike`), because a
  // container-only freeze proves nothing about the leaf a gate keys off.
  return { world: fitWorld, fit: Object.freeze(fit) };
}

/**
 * Round to 12 decimal places (`Number.prototype.toFixed(12)` — fractional
 * digits, not significant figures) so the fit summary hashes stably.
 *
 * Exported because it is a CROSS-MODULE contract, not a local convenience: the
 * auditor's data-sufficiency gate recomputes a coverage ratio this module
 * quantized and compares the two for equality, and the CLI report labels
 * scarcity off the same comparison. A second copy anywhere would let the two
 * sides drift silently — the gate would then reject every honest forecast — so
 * there is exactly one quantizer and both consumers import it.
 *
 * The contract every cross-module consumer relies on is the FIRST overload: a
 * number in, a number out — each of them feeds the result straight into `>=`,
 * `!==`, or `toFixed`, none of which an `unknown` admits. The permissive
 * pass-through is the second overload, for the artifact-summary call sites that
 * quantize a possibly-absent stat.
 *
 * Each overload gets its OWN comment block, and the implementation signature a
 * final one: TypeScript's `@overload` form reads one signature per block, so
 * collapsing them into a single block would publish the permissive
 * `unknown -> unknown` signature alone — exactly the shape the paragraph above
 * says the cross-module consumers cannot use.
 */

/**
 * @overload
 * @param {number} value
 * @returns {number}
 */

/**
 * @overload
 * @param {unknown} value
 * @returns {unknown}
 */

/**
 * @param {unknown} value
 * @returns {unknown}  the quantized number, or `value` unchanged when it is not
 *   a finite number (the callers that need a number check first)
 */
export function round12(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(reflectApply(numberToFixed, value, [12]))
    : value;
}

/**
 * The single most persistent instrument in a fitted vol regime — the portfolio
 * is only as calm as its worst (most clustering) asset, so every regime read
 * keys off the max per-asset GARCH persistence (α+β). Returns `{ worstAsset,
 * persistence }`, with `worstAsset: null` / `persistence: 0` when the fit
 * carries no usable per-asset persistence (no `volFit`, no `assets`, or every
 * entry non-finite) — the inert case every caller treats as "no regime signal".
 *
 * Shared by the auditor's regime-tail-floor and the forecaster's regime-horizon
 * so the two levers key off the SAME worst-asset the same way.
 *
 * TOTAL over every input, because one of its two callers is the auditor, whose
 * `forecast` is caller-supplied on the `audit_proposal` / fire-time re-audit
 * surface: a hostile `assets` proxy that throws from `ownKeys`, or a stat record
 * that throws from a `persistence` accessor, reads as no regime signal — the
 * same inert answer an absent volFit gives. A gate owes a verdict, not an
 * exception, and this call runs BEFORE every fail-closed branch the auditor has.
 *
 * @param {object|null|undefined} volFit   a forecast's `volFit` (`{ assets: { [asset]: { persistence } } }`)
 * @returns {{ worstAsset: string|null, persistence: number }}
 */
export function worstAssetPersistence(volFit) {
  const inert = { worstAsset: null, persistence: 0 };
  let assets;
  try {
    assets = volFit && typeof volFit === 'object' ? volFit.assets : null;
  } catch (_error) {
    return inert; // a hostile assets accessor is not a regime signal
  }
  if (!assets || typeof assets !== 'object') return inert;
  let entries;
  try {
    entries = Object.entries(assets);
  } catch (_error) {
    return inert; // a hostile ownKeys trap is not a regime signal
  }
  let worstAsset = null;
  let maxPersistence = -Infinity;
  for (const [asset, st] of entries) {
    let persistence;
    try {
      persistence = st && typeof st === 'object' ? st.persistence : null;
    } catch (_error) {
      continue; // a throwing accessor is no persistence estimate
    }
    if (typeof persistence !== 'number' || !Number.isFinite(persistence)) continue;
    // Ties break LEXICOGRAPHICALLY, never on `Object.entries` order: this
    // `worstAsset` rides into `horizonRegime` and thence into the hashed
    // artifact, so a key-order tie-break would make `projectionId` depend on how
    // the price map happened to be built — the same discipline (and the same
    // reason) as the data-sufficiency descriptor's worst-constituent tie-break.
    // The `worstAsset != null` guard is what makes the comparison well-typed:
    // it holds whenever `maxPersistence` is finite, but only the explicit test
    // says so to a reader (or a checker) of this line alone.
    if (persistence > maxPersistence || (persistence === maxPersistence && worstAsset != null && asset < worstAsset)) {
      maxPersistence = persistence;
      worstAsset = asset;
    }
  }
  if (worstAsset == null) return inert;
  return { worstAsset, persistence: maxPersistence };
}

/**
 * Deterministic linear ramp of a persistence value from `lo` (→ 0, no stress) to
 * `hi` (→ 1, full stress), clamped to [0, 1]. A degenerate `lo === hi` window is
 * a step at `hi`. Shared by every regime lever so a given persistence produces
 * the identical stress fraction whether it tightens the tail floor or stretches
 * the horizon.
 *
 * @param {number} persistence
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function persistenceStress(persistence, lo, hi) {
  const span = hi - lo;
  if (span > 0) return Math.max(0, Math.min(1, (persistence - lo) / span));
  return persistence >= hi ? 1 : 0;
}

/**
 * Compute the (possibly regime-stretched) projection horizon. A persistent vol
 * regime (high worst-asset GARCH persistence in the fitted `volFit`) holds its
 * elevated conditional variance for many ticks, so a shock this cycle compounds
 * rather than mean-reverting away inside a short window — projecting LONGER lets
 * the drawdown-and-recovery dynamics the auditor's pathStats read out resolve
 * instead of truncating mid-shock. The stretch is a deterministic linear ramp of
 * the WORST asset's persistence (the same worst-asset the tail floor keys off)
 * from `lo` (→ no stretch) to `hi` (→ full `stretch`), multiplied into the base
 * horizon and rounded, bounded by `cap`. When `stretch` is 0 (default) or the
 * forecast carries no persistent-enough regime, the horizon is exactly
 * `baseHorizon` and `regime` is null — so the projection stays byte-identical.
 *
 * The companion of the auditor's `regimeTailFloor`: measure-the-regime (adaptive
 * vol fit) then let-the-regime-decide, here on the projection depth.
 *
 * @param {object} args
 * @param {number} args.baseHorizon
 * @param {object|null} args.volFit          the forecast's fitted vol regime (`{ assets: {...} }`)
 * @param {number} args.stretch              max fractional extension at full persistence (0 → off)
 * @param {number} args.lo                   persistence at/below which the stretch is 0
 * @param {number} args.hi                   persistence at/above which the stretch is full
 * @param {number} args.cap                  the stretched horizon never exceeds this many ticks
 * @returns {{ horizon: number, regime: { baseHorizon: number, persistence: number, worstAsset: string, stress: number }|null }}
 */
export function regimeHorizon({ baseHorizon, volFit, stretch, lo, hi, cap }) {
  if (!(stretch > 0) || !volFit) return { horizon: baseHorizon, regime: null };
  const { worstAsset, persistence } = worstAssetPersistence(volFit);
  if (worstAsset == null) return { horizon: baseHorizon, regime: null };
  const stress = persistenceStress(persistence, lo, hi);
  if (stress <= 0) return { horizon: baseHorizon, regime: null };
  const stretched = Math.min(cap, Math.round(baseHorizon * (1 + stretch * stress)));
  if (stretched <= baseHorizon) return { horizon: baseHorizon, regime: null };
  return {
    horizon: stretched,
    // Frozen alongside the other two artifact-borne records (`volFit`, the
    // data-sufficiency descriptor) so none of them can drift from the hash.
    regime: Object.freeze({
      baseHorizon,
      persistence: round12(persistence),
      worstAsset,
      stress: round12(stress),
    }),
  };
}

/**
 * Does this frame carry an OWN, POSITIVE observation of `asset`?
 *
 * Own-property only: an inherited price is not an observation the feed made, and
 * a prototype-chain read would let frames with no own properties at all pad the
 * count — the very padding this helper exists to reject. A non-positive or
 * non-finite price is a stalled/absent sentinel rather than an observation (no
 * return can be computed across a zero), so it is not evidence either — hence
 * POSITIVE in the name: a finite `0` or `-1` is not an observation here.
 *
 * The property is read through its own DESCRIPTOR rather than by `frame[asset]`:
 * a bare `Object.hasOwn(frame, asset)` proves the property exists, not that it
 * is a data property, so a plain read would invoke an own accessor — and a frame
 * is untrusted input, so a hostile getter would throw out of `project()` instead
 * of counting as no evidence. An accessor carries no `value`, so it reads as
 * absent, which is the fail-closed answer on the producing side too.
 *
 * The descriptor's own `value` is tested with `Object.hasOwn`, never `'value' in
 * descriptor`: a descriptor object is an ordinary object inheriting from
 * `Object.prototype`, and `in` is `HasProperty`, which walks that chain. A single
 * polluted `Object.prototype.value` would otherwise make every ACCESSOR
 * descriptor — which carries no own `value` — answer with the polluted price,
 * turning "this frame observed nothing" into full coverage. The ownness check
 * must itself be prototype-independent, or it is not an ownness check.
 *
 * @param {unknown} frame
 * @param {string} asset
 * @returns {boolean}
 */
function hasOwnPositivePrice(frame, asset) {
  if (!frame || typeof frame !== 'object') return false;
  let descriptor;
  try {
    descriptor = getOwnPropertyDescriptor(frame, asset);
  } catch (_error) {
    return false; // a hostile proxy trap is not evidence either
  }
  if (!descriptor || !hasOwn(descriptor, 'value')) return false;
  const price = descriptor.value;
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

/**
 * Read one ELEMENT of an untrusted array-like by index, without letting a
 * hostile `get` trap abort the measurement: a frame that throws on read is not
 * evidence, exactly as a frame carrying no own price is not. (Named for what it
 * returns — the element — as its sibling `safeLength` is.)
 *
 * @param {ArrayLike<unknown>} arrayLike
 * @param {number} index
 * @returns {unknown}  the element, or `undefined` when the read throws
 */
function safeElementAt(arrayLike, index) {
  try {
    return arrayLike[index];
  } catch (_error) {
    return undefined;
  }
}

/**
 * The walk budget for an untrusted array-like (see `safeLength`). Four orders of
 * magnitude above any window this loop is run on — `--fit-window` is a tick
 * count an operator types — and small enough that the walk is bounded work.
 */
const MAX_UNTRUSTED_LENGTH = 1e6;

/**
 * The length of an untrusted array-like as a whole, non-negative count, read
 * EXACTLY ONCE so a `length` trap that answers differently on each read cannot
 * grow the window mid-walk (a one-element array reporting a rising `length`
 * would otherwise pad the frame count with `undefined`s that read as observed
 * only if the predicate let them).
 *
 * Snapshotting is necessary but not sufficient: a length is also BOUNDED, because
 * `Array.isArray` is true of a Proxy over an array and `length` is writable, so a
 * single honest-looking frame can report `2**53-1` and turn a measurement into an
 * unbounded synchronous walk inside the OODA loop. Every other hostile shape here
 * degrades to "no evidence" in O(1); this one must degrade too. Truncating to the
 * budget is the fail-closed direction — a shorter window carries FEWER returns,
 * hence less coverage, never more.
 *
 * @param {ArrayLike<unknown>} arrayLike
 * @returns {number}
 */
function safeLength(arrayLike) {
  let raw;
  try {
    raw = arrayLike.length;
  } catch (_error) {
    return 0;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !(raw > 0)) return 0;
  return Math.min(Math.trunc(raw), MAX_UNTRUSTED_LENGTH);
}

/**
 * Frames and RETURNS from a per-frame observed/not-observed predicate. A return
 * needs two ADJACENT observations, so returns accumulate only inside a maximal
 * run: a feed that alternates observed/missing carries many frames and no
 * returns, and counting `frames - 1` would credit it with returns it never
 * observed. (Note that `historyFrames` is a plain total, contiguity-aware only
 * in `historyReturns`.)
 *
 * The frames are walked by INDEX rather than through `frames.map`: `frames` is
 * caller-supplied, `Array.isArray` says nothing about which `map` a [[Get]]
 * resolves to, and an own `map` that fabricates a longer mask would forge the
 * very coverage this measurement exists to bound. For the same reason the
 * length is snapshotted once and bounded (`safeLength`) and each element read
 * through `safeElementAt`: a `length` trap that grows on each read would pad the
 * window, one that reports an enormous length would hang the walk, and a
 * throwing `get` trap would abort `project()` instead of reading as the absence
 * of evidence it is.
 *
 * @param {ArrayLike<unknown>} frames
 * @param {(frame: unknown) => boolean} observed
 * @returns {{ historyFrames: number, historyReturns: number }}
 */
function countObservedFramesAndReturns(frames, observed, length = safeLength(frames)) {
  let historyFrames = 0;
  let historyReturns = 0;
  let run = 0;
  for (let i = 0; i < length; i += 1) {
    if (!observed(safeElementAt(frames, i))) { run = 0; continue; }
    run += 1;
    historyFrames += 1;
    if (run > 1) historyReturns += 1;
  }
  return { historyFrames, historyReturns };
}

/**
 * The projected asset names, snapshotted from an untrusted list by INDEX — never
 * through `assets.filter`, for the reason the frame walk refuses `frames.map`:
 * `Array.isArray` says nothing about which `filter` a [[Get]] resolves to, and
 * an own `filter` that drops the thin constituent (or invents a fat one) forges
 * the worst-asset coverage this measurement exists to report. A throwing trap
 * reads as no names rather than aborting `project()`.
 *
 * The second half of the return says whether the list was MALFORMED — supplied
 * but carrying an element this measurement cannot name an asset from. ANY
 * non-string element malforms the WHOLE list, rather than being quietly dropped:
 * coverage is the worst-covered constituent, so silently measuring a SUBSET
 * reports at-least-as-much coverage as measuring the whole (`[42, 'ATOM']` would
 * otherwise read as `['ATOM']` and hide whatever the unnameable element stood
 * for). A measurement feeding a fail-closed gate degrades toward LESS coverage,
 * so an unreadable element makes the list unmeasurable, not smaller.
 *
 * @param {unknown} assets
 * @returns {{ named: string[], malformed: boolean }}
 */
function namedAssets(assets) {
  if (assets == null) return { named: [], malformed: false };
  if (!Array.isArray(assets)) return { named: [], malformed: true };
  const named = [];
  const length = safeLength(assets);
  // `safeLength` truncates at its budget, which is the fail-CLOSED direction for
  // a frame window (fewer frames, less coverage) and the fail-OPEN one here
  // (fewer constituents, and worst-of-a-subset is at least worst-of-the-whole).
  // A list long enough to be truncated is therefore unmeasurable, not shorter.
  if (length >= MAX_UNTRUSTED_LENGTH) return { named: [], malformed: true };
  for (let i = 0; i < length; i += 1) {
    const asset = safeElementAt(assets, i);
    if (typeof asset !== 'string') return { named: [], malformed: true };
    named.push(asset);
  }
  return { named: [...new Set(named)], malformed: false };
}

/**
 * Measure the observed frames and returns that actually carry evidence about the
 * projected assets, and name the worst-covered one. A frame with no own positive
 * price for an asset says nothing about that asset, so an empty or partial frame
 * cannot pad the count — the failure mode a bare `frames.length` has, where a
 * stalled feed emitting empty price maps (`{}`, once the reading's `prices` is
 * unwrapped) reads as a full window.
 *
 * With NO assets named — omitted, an empty array, or a MALFORMED list (`[42]`, a
 * bare string, a list with any unnameable element) — the measurement is ZERO.
 * There is no portfolio-wide fallback that counts a frame carrying "at least one
 * own positive price", because without an asset set to intersect against, no
 * predicate can tell a price from any other positive number: a stalled feed
 * emitting `{ observedAtTick: n }` frames observes no price at all and would
 * measure full coverage, as would an array-shaped frame (own `length`) or a
 * boxed string. That fallback was strictly more permissive than every per-asset
 * path around it, and a measurement feeding a fail-closed gate degrades toward
 * LESS coverage, uniformly — an unknown shape is absence of evidence, and
 * absence of evidence is not evidence of sufficiency. `project()` names the
 * projected target weights, so the zero case is a projection with no targets:
 * nothing to measure per asset, hence nothing measured.
 *
 * The bare-count overload trusts a caller that already
 * counted its own window: only a `number` is honored (never `Number('8')`), its
 * coercion is guarded (`Number.isFinite` + `Math.trunc`, never `| 0`, which is
 * ToInt32 and wraps a large count around 2^31), and it too names no worst asset.
 *
 * The worst constituent is the fewest observed returns, tie-broken on frames and
 * then LEXICOGRAPHICALLY (UTF-16 code-unit order, which is spec-fixed and so
 * hash-stable across engines; never `localeCompare`) — and never on the caller's
 * key order, which would make the descriptor (and the artifact hashing it)
 * depend on how `targetWeights` was built.
 *
 * @param {unknown} frames   an array of untrusted per-tick price maps
 *   (`{ ASSET: price }`, as `priceFramesFromReadings` returns), or a bare count
 * @param {unknown} assets   the asset names to measure, when known
 * @returns {{ historyFrames: number, historyReturns: number, worstAsset: string|null }}
 */
function measureHistoryCoverage(frames, assets) {
  if (!Array.isArray(frames)) {
    const count = typeof frames === 'number' && Number.isFinite(frames)
      ? Math.max(0, Math.trunc(frames)) : 0;
    return { historyFrames: count, historyReturns: Math.max(0, count - 1), worstAsset: null };
  }
  const { named } = namedAssets(assets);
  // No nameable asset — malformed, empty, or omitted — measures zero. See the
  // docstring: there is nothing to intersect an "is this a price?" predicate
  // against, so the only honest count is none.
  if (named.length === 0) return { historyFrames: 0, historyReturns: 0, worstAsset: null };
  const frameLength = safeLength(frames);
  if (frameLength > 0 && named.length > Math.floor(MAX_UNTRUSTED_LENGTH / frameLength)) {
    return { historyFrames: 0, historyReturns: 0, worstAsset: null };
  }
  // Seeded from the first named asset rather than from `null`, so the declared
  // (non-nullable) return holds on every path a checker can see, not only on the
  // one the empty-list early return happens to have excluded.
  let worstCoverage = {
    ...countObservedFramesAndReturns(frames, (frame) => hasOwnPositivePrice(frame, named[0]), frameLength),
    worstAsset: named[0],
  };
  for (let i = 1; i < named.length; i += 1) {
    const asset = named[i];
    const counts = countObservedFramesAndReturns(
      frames, (frame) => hasOwnPositivePrice(frame, asset), frameLength,
    );
    if (counts.historyReturns < worstCoverage.historyReturns
        || (counts.historyReturns === worstCoverage.historyReturns
            && (counts.historyFrames < worstCoverage.historyFrames
                || (counts.historyFrames === worstCoverage.historyFrames
                    && asset < worstCoverage.worstAsset)))) {
      worstCoverage = { ...counts, worstAsset: asset };
    }
  }
  return worstCoverage;
}

/**
 * @typedef {object} DataSufficiency
 * @property {number} historyFrames    observed frames carrying an own POSITIVE price for the
 *   worst-covered asset (0 when no asset was nameable; on the bare-count overload: the count the
 *   caller supplied). Positive, not merely finite: a `0` or negative
 *   price is a stalled/absent sentinel that no return can be computed across, so it is not evidence
 * @property {number} historyReturns   the returns those frames yield — only ADJACENT observed frames
 *   yield a return, so a gappy window carries fewer returns than `historyFrames - 1`. A count of
 *   OBSERVATIONS, not of information: a feed that repeats one unchanging price yields returns here
 *   (each adjacent pair is two observations) though it carries no new signal, which is why the vol
 *   fit refuses such a window (`fitForecastWorld`) while this descriptor still measures it. Coverage
 *   answers "did the feed report across this span", not "did the reports say anything"
 * @property {string|null} worstAsset  the asset the coverage was measured on (null when none were
 *   named, and on the bare-count overload, which has no frames to measure per asset)
 * @property {number|null} horizon     the ticks projected forward, NORMALIZED to a whole tick count:
 *   the projection's own `horizon` when that is a non-negative integer, else `null` for UNMEASURABLE.
 *   A non-finite, negative, or fractional horizon is not a tick count, and normalizing it to a clean
 *   `0` would mint the one descriptor a consumer may read as "projects nothing, so it cannot outrun
 *   its window" out of the input that most outruns it
 * @property {number|null} coverageRatio   observed returns per projected tick (0 when the horizon is
 *   0, and null when the horizon is unmeasurable — there is no ratio to report)
 */

/**
 * Name whether a projection outruns its observed evidence: the forecaster
 * projects `horizon` ticks forward from a window of observed price frames, and a
 * horizon that exceeds the observed returns is extrapolating past its data (the
 * ensemble-forecasting design's open question about a horizon that exceeds the
 * historical window; see designs/ensemble-forecasting.md). The `coverageRatio`
 * is the observed returns per projected tick: 1.0 means the window carries one
 * observed return per tick projected.
 *
 * Coverage is measured PER ASSET and reported for the WORST-covered one, the
 * same worst-constituent convention `worstAssetPersistence` uses: a portfolio is
 * only as well-evidenced as its thinnest instrument, so a freshly-listed asset
 * inside a long window cannot hide behind its better-observed neighbours.
 *
 * "Worst-covered" ranges over the assets the CALLER names. `project()` names the
 * union of its projected targets and its current portfolio holdings: bounded
 * exits can retain an untargeted holding through the horizon, so that holding
 * must not be invisible to the terminal-equity gate.
 *
 * Measurement only, no policy. The descriptor carries counts and the ratio; the
 * consumer (the auditor's gate, the CLI report) owns the threshold it is judged
 * against. Keeping the operator's threshold out of the descriptor keeps it out
 * of the hashed artifact, so two otherwise byte-identical ensembles cannot get
 * two different `projectionId`s from a reporting knob alone.
 *
 * Pure and deterministic (counts + arithmetic, no RNG), so a projection that
 * carries the descriptor still hashes stably.
 *
 * @param {object} input
 * @param {unknown} input.frames   the observed price frames used — an array of per-tick price maps
 *   (`{ ASSET: price }`, what `priceFramesFromReadings` returns), or a bare count. The frames are
 *   untrusted shapes, so each price is read from its own descriptor and type-checked rather than assumed
 * @param {unknown} input.horizon   ticks projected forward; anything that is not a non-negative integer
 *   tick count is reported as UNMEASURABLE (`horizon: null`) rather than normalized to a number
 * @param {unknown} [input.assets]   the assets projected; coverage is the worst-covered of these. Omitted,
 *   EMPTY (as `project()` passes when `targetWeights` is empty), or carrying any element that is not an
 *   asset name measures ZERO and reports `worstAsset: null`: with no asset set, no predicate can tell a
 *   price from any other positive number, so there is nothing to measure rather than everything
 * @returns {DataSufficiency}   frozen, so the descriptor a consumer gates on cannot diverge from the
 *   one `projectionArtifact` hashed
 */
export function computeDataSufficiency({ frames, horizon, assets }) {
  const { historyFrames, historyReturns, worstAsset } = measureHistoryCoverage(frames, assets);
  // A horizon that is not a whole, non-negative tick count is UNMEASURABLE, not
  // zero. Clamping it to 0 would be worse than useless here: 0 is the one
  // horizon a consumer may legitimately read as "this projection cannot outrun
  // its window", so the most extreme input (a NaN horizon from a typo'd flag)
  // would mint the cleanest-looking descriptor. `null` says what is true — the
  // measurement could not be made — and serializes stably into the artifact, so
  // a consumer gating on this evidence fails closed instead of open.
  const projectedTicks = typeof horizon === 'number' && Number.isInteger(horizon) && horizon >= 0
    ? horizon
    : null;
  const coverageRatio = projectedTicks == null
    ? null
    : round12(projectedTicks > 0 ? historyReturns / projectedTicks : 0);
  // Frozen at production: `projectionArtifact` aliases this object into the
  // record whose JSON becomes `projectionId`, so a holder mutating it after the
  // id was computed would leave the hash and the evidence a fail-closed gate
  // reads disagreeing on the one field that decides the verdict. `Object.freeze`
  // rather than `harden` because this module must work whether or not
  // `lockdown()` has run — importing the package entry point pulls in
  // `cap-attenuation.js`, which does call it, but importing `./forecaster.js`
  // alone does not, and `harden` is not a global until then. A shallow freeze
  // suffices HERE only because every field of this record is a primitive; where
  // that does not hold (the vol fit's per-asset stats) the freeze goes deeper.
  return Object.freeze({
    historyFrames,
    historyReturns,
    worstAsset,
    horizon: projectedTicks,
    coverageRatio,
  });
}

/**
 * A projection.
 *
 * `horizonRegime` and `dataSufficiency` are marked OPTIONAL rather than required because this typedef
 * stands in PARAMETER position too (`audit()`, `execute()`, and through them the LLM-facing
 * `audit_proposal` / `simulate_execution` tools, which hand-build a forecast object). `project()`
 * always sets both keys; a caller-supplied forecast routinely carries neither, and the consumers are
 * written for that absence — declaring them required would tell a checker the opposite of what the
 * readers expect. (Stated here rather than between the `@property` tags below: a blank line does not
 * end a tag description, so a paragraph inside the block is absorbed into whichever property precedes
 * it.)
 *
 * @typedef {object} ForecastProjection
 * @property {Record<string, number>} targetWeights
 * @property {number} horizon
 * @property {number} ensembleSize
 * @property {number} baseSeed
 * @property {number} currentNav
 * @property {object} summary        from simulator forecast(): meanEquity, p05..p95, pProfit, ...
 * @property {object} histogram      { binEdges, counts, binWidth }
 * @property {object} quantileBands  bootstrap confidence bands on tail quantiles
 * @property {object} pathStats      max-drawdown + time-to-recovery distributions
 * @property {number} p05Equity      5th-percentile terminal equity (tail-risk anchor)
 * @property {number} p50Equity
 * @property {number} pProfit
 * @property {Array<object>} actionSteps   the steps the projection applied at t=1
 * @property {object|null} [horizonRegime]   the citation trail for why `horizon > baseHorizon`
 *   (`{ baseHorizon, persistence, worstAsset, stress }`); null when no persistent regime stretched it
 * @property {DataSufficiency|null} [dataSufficiency]   whether the projection outruns its observed
 *   window, so a downstream gate can refuse a thin forecast; null unless `config.reportDataSufficiency`
 *   is set, and omitted from `projectionArtifact` when null (so the content hash is unaffected)
 * @property {string} [projectionSvg]      deterministic SVG render of the histogram
 */

/**
 * Build the t=1 action function that applies the candidate rebalance on a
 * forked child world.
 *
 * @param {Record<string, number>} targetWeights
 * @param {object} bounds
 * @returns {Function}  (world, t, prices) => void
 */
export function makeRebalanceAction(targetWeights, bounds) {
  return function rebalanceAction(world, t, prices) {
    const snapshot = world.portfolio.markToMarket(prices);
    const { steps } = deriveSteps(snapshot, prices, targetWeights, bounds);
    applyStepsToPortfolio(world.portfolio, prices, steps, t);
  };
}

/**
 * Run the Monte Carlo projection of a candidate rebalance.
 *
 * @param {object} input
 * @param {import('@finbot/simulator/world').World} input.world
 * @param {Record<string, number>} input.targetWeights
 * @param {object} [input.bounds]            rebalance risk bounds (forwarded to deriveSteps)
 * @param {Array<{ t?: number, prices?: Record<string, number> }>} [input.readings]  observed window, for an adaptive vol fit
 * @param {Array<{ t?: number, prices?: Record<string, number> }>} [input.fitReadings]  a LONGER rolling
 *   window used ONLY for the adaptive vol fit, so the per-asset GARCH MLE can engage on a short live
 *   cycle. Absent → the fit uses `input.readings`, byte-identical to before.
 * @param {object} [config]
 * @param {number} [config.horizon]          ticks per child (default 20)
 * @param {number} [config.ensembleSize]     children (default 200)
 * @param {number} [config.baseSeed]         child-seed schedule anchor (default 1000)
 * @param {number} [config.bins]             histogram bins (default 12)
 * @param {boolean} [config.render]          attach a deterministic SVG projection (default true)
 * @param {string} [config.program]          program label carried into the render header
 * @param {object} [config.adaptiveVol]      volSurface descriptor WITHOUT data (e.g. `{ kind: 'garch' }`); its
 *                                           `history` is fit from `input.readings`, so the ensemble models the
 *                                           volatility regime actually observed this cycle instead of the world's
 *                                           statically-configured surface. Absent → the world is used unchanged.
 * @param {number} [config.regimeHorizonStretch]   max FRACTIONAL horizon extension a fully persistent vol regime
 *   adds to the base horizon (default 0 → OFF, horizon unchanged). The adaptive fit's worst-asset GARCH persistence
 *   ramps this: a persistent regime holds elevated conditional variance for many ticks, so a shock this cycle isn't
 *   mean-reverted away inside a short horizon — projecting it LONGER lets the drawdown-and-recovery dynamics the
 *   auditor reads resolve instead of truncating mid-shock. Inert without an `adaptiveVol` fit (no `volFit`).
 * @param {number} [config.regimePersistenceLo]    persistence at/below which the stretch is 0 (default 0.70)
 * @param {number} [config.regimePersistenceHi]    persistence at/above which the stretch is full (default 0.98)
 * @param {number} [config.regimeHorizonCap]       the regime-stretched horizon never exceeds this many ticks (default 60)
 * @param {boolean} [config.reportDataSufficiency]  attach a `dataSufficiency` descriptor naming whether the
 *   projection outruns its observed window (default false -> the descriptor is `null` and
 *   `projectionArtifact` omits it, so the hashed artifact and its `projectionId` stay byte-identical to
 *   before; the returned projection object carries the key either way, as it does for `horizonRegime`).
 *   The descriptor is pure measurement — the threshold it is judged against belongs to the consumer
 *   (the auditor's `dataSufficiencyMinCoverage` gate), never to the forecaster.
 * @returns {ForecastProjection}
 */
export function project(input, config = {}) {
  const baseHorizon = config.horizon != null ? config.horizon : 20;
  const ensembleSize = config.ensembleSize != null ? config.ensembleSize : 200;
  const baseSeed = config.baseSeed != null ? config.baseSeed : 1000;
  const bins = config.bins != null ? config.bins : 12;
  const render = config.render !== false;
  const program = config.program || 'rebalance';
  const bounds = input.bounds || {};
  const regimeHorizonStretch = config.regimeHorizonStretch != null ? config.regimeHorizonStretch : 0;
  const regimePersistenceLo = config.regimePersistenceLo != null ? config.regimePersistenceLo : 0.70;
  const regimePersistenceHi = config.regimePersistenceHi != null ? config.regimePersistenceHi : 0.98;
  const regimeHorizonCap = config.regimeHorizonCap != null ? config.regimeHorizonCap : 60;

  // Current snapshot is read from the ORIGINAL world, so currentNav and the
  // cited actionSteps stay byte-identical whether or not an adaptive fit runs
  // — the fit reshapes the projected distribution, never the present state.
  const currentPrices = input.world.priceFeed.current();
  const currentNav = navOf(input.world.portfolio.markToMarket(currentPrices), currentPrices);

  // Optionally fit a conditional-vol surface from the observed window and
  // project the ensemble under it (adaptive per-instrument vol). Off by
  // default and inert on a too-short/degenerate window → unchanged behaviour.
  // The adaptive fit prefers a longer `fitReadings` when the caller supplies one
  // (engaging the per-asset MLE on a short live window); else it fits from the
  // same `readings` as before. Both windows end at the current tick.
  const fitReadings = input.fitReadings && input.fitReadings.length >= (input.readings || []).length
    ? input.fitReadings
    : input.readings;
  const { world: forecastWorld, fit: volFit } = fitForecastWorld(
    input.world, fitReadings, config.adaptiveVol,
  );

  // Regime-aware horizon: a persistent vol regime projects LONGER so a clustered
  // shock resolves inside the window instead of truncating mid-shock. Off by
  // default (stretch 0) or on a non-persistent regime → `horizon === baseHorizon`
  // and `horizonRegime === null`, so the projection — and its content hash — stay
  // byte-identical to before.
  const { horizon, regime: horizonRegime } = regimeHorizon({
    baseHorizon, volFit,
    stretch: regimeHorizonStretch,
    lo: regimePersistenceLo, hi: regimePersistenceHi, cap: regimeHorizonCap,
  });

  // Data-sufficiency: name whether this projection outruns its observed
  // evidence. The window measured is the SAME one the adaptive fit draws on
  // (`fitReadings`, the longer rolling window when supplied), against the
  // possibly regime-stretched `horizon` — so a regime that stretched the horizon
  // correctly lowers the coverage it must be justified against. Coverage is
  // measured on every asset that can contribute to the projected terminal equity
  // and reported for the worst-covered one, so a thin newcomer or residual
  // holding in a well-observed portfolio still reads as thin.
  // Off by default (`config.reportDataSufficiency` unset) -> the descriptor is
  // null and `projectionArtifact` omits it, so the hashed artifact and its
  // content hash stay byte-identical to before; computed only when asked.
  const dataSufficiency = config.reportDataSufficiency
    ? computeDataSufficiency({
        frames: priceFramesForCoverage(fitReadings),
        horizon,
        assets: [...new Set([
          ...Object.keys(input.targetWeights || {}),
          ...Object.entries(input.world.portfolio.balances || {})
            .filter(([_asset, balance]) => typeof balance === 'number' && balance !== 0)
            .map(([asset]) => asset),
        ])],
      })
    : null;

  const action = makeRebalanceAction(input.targetWeights, bounds);
  const result = simForecast({
    from: forecastWorld,
    action,
    horizon,
    ensembleSize,
    baseSeed,
    bins,
    profitThreshold: 0,
    render,
    program,
  });

  // Record the deterministic steps the action would apply at current prices
  // (for the citation trail; the actual per-child steps re-derive at each
  // child's t=1 prices).
  const snapshot = input.world.portfolio.markToMarket(currentPrices);
  const { steps: actionSteps } = deriveSteps(snapshot, currentPrices, input.targetWeights, bounds);

  return {
    program,
    targetWeights: input.targetWeights,
    horizon,
    ensembleSize,
    baseSeed,
    currentNav,
    summary: result.summary,
    histogram: result.histogram,
    quantileBands: result.quantileBands,
    pathStats: result.pathStats,
    p05Equity: result.summary.p05,
    p50Equity: result.summary.p50,
    pProfit: result.summary.pProfit,
    actionSteps,
    volFit,
    horizonRegime,
    dataSufficiency,
    projectionSvg: result.projectionSvg,
  };
}

/**
 * Canonical JSON serialization of a forecast projection's data (excludes
 * the rendered SVG, which is derived). Stable key order so the content
 * hash is deterministic across runs.
 *
 * @param {ForecastProjection} projection
 * @returns {object}
 */
export function projectionArtifact(projection) {
  const artifact = {
    program: projection.program,
    targetWeights: projection.targetWeights,
    horizon: projection.horizon,
    ensembleSize: projection.ensembleSize,
    baseSeed: projection.baseSeed,
    currentNav: projection.currentNav,
    summary: projection.summary,
    histogram: projection.histogram,
    quantileBands: projection.quantileBands,
    pathStats: projection.pathStats,
    p05Equity: projection.p05Equity,
    p50Equity: projection.p50Equity,
    pProfit: projection.pProfit,
    actionSteps: projection.actionSteps,
  };
  // Only present when an adaptive vol surface was actually fit, so a plain
  // (non-adaptive) projection's artifact JSON — and thus its content hash and
  // the auditor's recompute-and-compare — stay byte-identical to before.
  if (projection.volFit) artifact.volFit = projection.volFit;
  // Likewise, only present when the regime actually stretched the horizon, so a
  // projection with the stretch off (or an inert regime) hashes exactly as before.
  if (projection.horizonRegime) artifact.horizonRegime = projection.horizonRegime;
  // Only present when the data-sufficiency report was requested, so a projection
  // without it hashes exactly as before.
  if (projection.dataSufficiency) artifact.dataSufficiency = projection.dataSufficiency;
  return artifact;
}

/**
 * Deterministic short-id for a projection: the leading hex of a SHA-256
 * over the canonical artifact JSON. Same forecast → same id → same
 * filenames, which is what makes the auditor's recompute-and-compare work.
 *
 * @param {ForecastProjection} projection
 * @returns {string}
 */
export function projectionId(projection) {
  const json = JSON.stringify(projectionArtifact(projection));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Write the forecaster's two artifacts — the histogram JSON and the SVG
 * projection — under a directory, honoring the role brief's output shape
 * (`histogram_path` + `projection_path`). The filenames are derived from
 * the deterministic projection id, so re-running the same forecast
 * overwrites byte-identical files.
 *
 * The fs surface is injected (an object exposing `mkdirSync` and
 * `writeFileSync`, e.g. node:fs) so the pure pipeline never hard-imports
 * the filesystem; callers in a test pass a fake.
 *
 * @param {ForecastProjection} projection
 * @param {object} args
 * @param {string} args.dir                  output directory
 * @param {{ mkdirSync: Function, writeFileSync: Function }} args.fs
 * @returns {{ histogram_path: string, projection_path: string, id: string }}
 */
export function writeForecastArtifacts(projection, { dir, fs }) {
  if (!fs || typeof fs.writeFileSync !== 'function') {
    throw new Error('writeForecastArtifacts: an fs with writeFileSync is required');
  }
  const id = projectionId(projection);
  if (typeof fs.mkdirSync === 'function') fs.mkdirSync(dir, { recursive: true });
  const sep = dir.endsWith('/') ? '' : '/';
  const histogramPath = `${dir}${sep}${id}.json`;
  const projectionPath = `${dir}${sep}${id}.svg`;
  if (!projection.projectionSvg) {
    throw new Error('writeForecastArtifacts: projection has no projectionSvg; call project() with render enabled (the default)');
  }
  fs.writeFileSync(histogramPath, `${JSON.stringify(projectionArtifact(projection), null, 2)}\n`);
  fs.writeFileSync(projectionPath, projection.projectionSvg);
  return { histogram_path: histogramPath, projection_path: projectionPath, id };
}
