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
 *   (e.g. `{ kind: 'garch' }` or `{ kind: 'gjr-garch', alpha, beta }`); its
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
 * @returns {ForecastProjection}
 */
export function project(input, config = {}) {
  const horizon = config.horizon != null ? config.horizon : 20;
  const ensembleSize = config.ensembleSize != null ? config.ensembleSize : 200;
  const baseSeed = config.baseSeed != null ? config.baseSeed : 1000;
  const bins = config.bins != null ? config.bins : 12;
  const render = config.render !== false;
  const program = config.program || 'rebalance';
  const bounds = input.bounds || {};

  // Current snapshot is read from the ORIGINAL world, so currentNav and the
  // cited actionSteps stay byte-identical whether or not an adaptive fit runs
  // — the fit reshapes the projected distribution, never the present state.
  const currentPrices = input.world.priceFeed.current();
  const currentNav = navOf(input.world.portfolio.markToMarket(currentPrices), currentPrices);

  // Optionally fit a conditional-vol surface from the observed window and
  // project the ensemble under it (adaptive per-instrument vol). Off by
  // default and inert on a too-short/degenerate window → unchanged behaviour.
  const { world: forecastWorld, fit: volFit } = fitForecastWorld(
    input.world, input.readings, config.adaptiveVol,
  );

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
