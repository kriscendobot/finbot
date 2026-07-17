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
 *   `{ kind: 'auto-gjr-garch' }`); its
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
 * @property {object} [horizonRegime]      present only when a persistent regime stretched the horizon:
 *   `{ baseHorizon, persistence, worstAsset, stress }` (the citation trail for why `horizon > baseHorizon`)
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
