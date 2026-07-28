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
    if (r && r.prices && typeof r.prices === 'object') frames.push(r.prices);
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
        assets[asset].oosQlike = Object.fromEntries(
          Object.entries(st.oosQlike).map(([model, value]) => [model, round12(value)]),
        );
      }
    }
    fit.assets = assets;
  }
  return { world: fitWorld, fit };
}

/** Round to 12 significant decimals so the fit summary hashes stably. */
function round12(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(12)) : x;
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
 * @param {object|null|undefined} volFit   a forecast's `volFit` (`{ assets: { [asset]: { persistence } } }`)
 * @returns {{ worstAsset: string|null, persistence: number }}
 */
export function worstAssetPersistence(volFit) {
  const assets = volFit && volFit.assets;
  if (!assets || typeof assets !== 'object') return { worstAsset: null, persistence: 0 };
  let worstAsset = null;
  let maxPersistence = -Infinity;
  for (const [asset, st] of Object.entries(assets)) {
    const p = st && typeof st.persistence === 'number' ? st.persistence : null;
    if (p == null || !Number.isFinite(p)) continue;
    if (p > maxPersistence) { maxPersistence = p; worstAsset = asset; }
  }
  if (worstAsset == null) return { worstAsset: null, persistence: 0 };
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
    regime: {
      baseHorizon,
      persistence: round12(persistence),
      worstAsset,
      stress: round12(stress),
    },
  };
}

/**
 * Does this frame carry an OWN observation of `asset`?
 *
 * Own-property only: an inherited price is not an observation the feed made, and
 * a prototype-chain read would let frames with no own properties at all pad the
 * count — the very padding this helper exists to reject. A non-positive or
 * non-finite price is a stalled/absent sentinel rather than an observation (no
 * return can be computed across a zero), so it is not evidence either.
 *
 * @param {unknown} frame
 * @param {string} asset
 * @returns {boolean}
 */
function hasOwnFinitePrice(frame, asset) {
  if (!frame || typeof frame !== 'object') return false;
  if (!Object.hasOwn(frame, asset)) return false;
  const price = frame[asset];
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

/**
 * Frames and RETURNS from a per-frame observed/not-observed mask. A return needs
 * two ADJACENT observations, so returns accumulate only inside a maximal run:
 * a feed that alternates observed/missing carries many frames and no returns,
 * and counting `frames - 1` would credit it with returns it never observed.
 *
 * @param {boolean[]} observed
 * @returns {{ historyFrames: number, historyReturns: number }}
 */
function contiguousCounts(observed) {
  let historyFrames = 0;
  let historyReturns = 0;
  let run = 0;
  for (const seen of observed) {
    if (!seen) { run = 0; continue; }
    run += 1;
    historyFrames += 1;
    if (run > 1) historyReturns += 1;
  }
  return { historyFrames, historyReturns };
}

/**
 * Count the observed frames and returns that actually carry evidence about the
 * projected assets, and name the worst-covered one. A frame with no own finite
 * price for an asset says nothing about that asset, so an empty or partial frame
 * cannot pad the count — the failure mode a bare `frames.length` has, where a
 * stalled feed emitting `{ t, prices: {} }` reads as a full window.
 *
 * With no assets named (omitted OR an empty array), a frame counts when it
 * carries at least one own finite price, and no per-asset worst constituent can
 * be named. The bare-count overload trusts a caller that already counted its own
 * window: only a `number` is honored (never `Number('8')`), its coercion is
 * guarded (`Number.isFinite` + `Math.trunc`, never `| 0`, which is ToInt32 and
 * wraps a large count around 2^31), and it too names no worst asset.
 *
 * The worst constituent is the fewest observed returns, tie-broken on frames and
 * then LEXICOGRAPHICALLY — never on the caller's key order, which would make the
 * descriptor (and the artifact hashing it) depend on how `targetWeights` was
 * built.
 *
 * @param {Array<Record<string, unknown>>|number} frames
 * @param {string[]|undefined} assets
 * @returns {{ historyFrames: number, historyReturns: number, worstAsset: string|null }}
 */
function countHistoryFrames(frames, assets) {
  if (!Array.isArray(frames)) {
    const count = typeof frames === 'number' && Number.isFinite(frames)
      ? Math.max(0, Math.trunc(frames)) : 0;
    return { historyFrames: count, historyReturns: Math.max(0, count - 1), worstAsset: null };
  }
  const named = (Array.isArray(assets) ? assets : []).filter((a) => typeof a === 'string');
  if (named.length === 0) {
    const observed = frames.map((frame) => frame != null && typeof frame === 'object'
      && Object.keys(frame).some((asset) => hasOwnFinitePrice(frame, asset)));
    return { ...contiguousCounts(observed), worstAsset: null };
  }
  let worst = null;
  for (const asset of named) {
    const counts = contiguousCounts(frames.map((frame) => hasOwnFinitePrice(frame, asset)));
    if (worst == null
        || counts.historyReturns < worst.historyReturns
        || (counts.historyReturns === worst.historyReturns
            && (counts.historyFrames < worst.historyFrames
                || (counts.historyFrames === worst.historyFrames && asset < worst.worstAsset)))) {
      worst = { ...counts, worstAsset: asset };
    }
  }
  return worst;
}

/**
 * @typedef {object} DataSufficiency
 * @property {number} historyFrames    observed frames carrying an own finite price for the worst-covered
 *   asset (with no assets named: frames carrying at least one own finite price; on the bare-count
 *   overload: the count the caller supplied)
 * @property {number} historyReturns   the returns those frames yield — only ADJACENT observed frames
 *   yield a return, so a gappy window carries fewer returns than `historyFrames - 1`
 * @property {string|null} worstAsset  the asset the coverage was measured on (null when none were
 *   named, and on the bare-count overload, which has no frames to measure per asset)
 * @property {number} horizon          ticks projected forward
 * @property {number} coverageRatio    observed returns per projected tick (0 when the horizon is 0)
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
 * Measurement only, no policy. The descriptor carries counts and the ratio; the
 * consumer (the auditor's gate, the CLI report) owns the threshold it is judged
 * against. Keeping the operator's threshold out of the descriptor keeps it out
 * of the hashed artifact, so two otherwise byte-identical ensembles cannot get
 * two different `projectionId`s from a reporting knob alone.
 *
 * Pure and deterministic (counts + arithmetic, no RNG), so a projection that
 * carries the descriptor still hashes stably.
 *
 * @param {object} args
 * @param {Array<Record<string, unknown>>|number} args.frames   the observed price frames used (or their
 *   count; the frames are untrusted shapes, so each price is type-checked rather than assumed)
 * @param {number} args.horizon                                ticks projected forward
 * @param {string[]} [args.assets]   the assets projected; coverage is the worst-covered of these. Omitted
 *   OR EMPTY (as `project()` passes when `targetWeights` is empty) falls back to portfolio-wide counting —
 *   a frame counts when it carries at least one own finite price — and reports `worstAsset: null`
 * @returns {DataSufficiency}
 */
export function computeDataSufficiency({ frames, horizon, assets }) {
  const { historyFrames, historyReturns, worstAsset } = countHistoryFrames(frames, assets);
  // Normalize the horizon before it lands in a hashed artifact: a non-finite
  // horizon would serialize to null and desync the content hash from the value.
  const projectedTicks = Number.isFinite(horizon) ? Math.max(0, horizon) : 0;
  const coverageRatio = projectedTicks > 0 ? historyReturns / projectedTicks : 0;
  return {
    historyFrames,
    historyReturns,
    worstAsset,
    horizon: projectedTicks,
    coverageRatio: round12(coverageRatio),
  };
}

/**
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
 * @property {object|null} horizonRegime   the citation trail for why `horizon > baseHorizon`
 *   (`{ baseHorizon, persistence, worstAsset, stress }`); null when no persistent regime stretched it
 * @property {DataSufficiency|null} dataSufficiency   whether the projection outruns its observed window,
 *   so a downstream gate can refuse a thin forecast; null unless `config.reportDataSufficiency` is set,
 *   and omitted from `projectionArtifact` when null (so the content hash is unaffected)
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
  // measured on the assets actually projected and reported for the worst-covered
  // one, so a thin newcomer in a well-observed portfolio still reads as thin.
  // Off by default (`config.reportDataSufficiency` unset) -> the descriptor is
  // null and `projectionArtifact` omits it, so the hashed artifact and its
  // content hash stay byte-identical to before; computed only when asked.
  const dataSufficiency = config.reportDataSufficiency
    ? computeDataSufficiency({
        frames: priceFramesFromReadings(fitReadings),
        horizon,
        assets: Object.keys(input.targetWeights || {}),
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
