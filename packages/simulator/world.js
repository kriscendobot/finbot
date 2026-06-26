/**
 * World shape.
 *
 * A `World` bundles the three pieces a simulation needs:
 *
 *   - portfolio:    @finbot/simulator/portfolio.Portfolio
 *   - priceFeed:    GBMPriceFeed | ReplayPriceFeed (or anything with the
 *                   same {tick, current, clone, t} surface)
 *   - harnessConfig: opaque config object the harness uses (planner
 *                    weights, capability subset, etc.). The simulator
 *                    does not interpret it; it passes it through to
 *                    whatever planner the world's tick function calls.
 *   - seed:         the user-facing seed for reproducibility tracking.
 *                   (The price feed already holds its own RNG; this
 *                   field is recorded in observations for replay.)
 *   - tag:          a string label for the world (e.g. 'outer',
 *                   'forecast-3'). Used in journal entry frontmatter.
 *
 * `makeWorld({...})` is a small convenience builder. The simulator
 * accepts any object with the right shape; you do not need to use the
 * builder.
 */

import { Portfolio } from './portfolio.js';
import { GBMPriceFeed, HarmonicPriceFeed, ReplayPriceFeed, parseCsvFrames } from './price-feed.js';

/**
 * @typedef {object} World
 * @property {import('./portfolio.js').Portfolio} portfolio
 * @property {object} priceFeed                       has tick() / current() / clone() / t
 * @property {object} harnessConfig
 * @property {number} seed
 * @property {string} tag
 */

/**
 * Build a World.
 *
 * @param {object} cfg
 * @param {object} [cfg.portfolio]                            Portfolio instance, or init for new Portfolio
 * @param {object} [cfg.priceFeed]                            PriceFeed instance, or { kind, ... } to build
 * @param {object} [cfg.harnessConfig]
 * @param {number} [cfg.seed]
 * @param {string} [cfg.tag]
 * @returns {World}
 */
export function makeWorld(cfg = {}) {
  const seed = cfg.seed != null ? cfg.seed : 42;
  const tag = cfg.tag || 'outer';
  const portfolio = cfg.portfolio instanceof Portfolio
    ? cfg.portfolio
    : new Portfolio(cfg.portfolio || {});
  let priceFeed;
  if (cfg.priceFeed && typeof cfg.priceFeed.tick === 'function') {
    priceFeed = cfg.priceFeed;
  } else {
    priceFeed = makePriceFeed(cfg.priceFeed || { kind: 'gbm', seed });
  }
  const harnessConfig = cfg.harnessConfig || {};
  return { portfolio, priceFeed, harnessConfig, seed, tag };
}

/**
 * Build a price feed from a config descriptor.
 *
 * @param {object} cfg
 * @returns {object}
 */
export function makePriceFeed(cfg) {
  const kind = cfg.kind || 'gbm';
  if (kind === 'gbm') {
    return new GBMPriceFeed({
      initialPrices: cfg.initialPrices || { USDC: 1.0, ATOM: 10.0 },
      drifts: cfg.drifts,
      volatilities: cfg.volatilities,
      dt: cfg.dt,
      seed: cfg.seed != null ? cfg.seed : 42,
      correlations: cfg.correlations,
      volSurface: cfg.volSurface,
    });
  }
  if (kind === 'harmonic') {
    return new HarmonicPriceFeed({
      initialPrices: cfg.initialPrices || { ASSET: 100 },
      models: cfg.models,
      dt: cfg.dt,
      seed: cfg.seed != null ? cfg.seed : 42,
    });
  }
  if (kind === 'replay') {
    let frames = cfg.frames;
    if (!frames && cfg.csv) frames = parseCsvFrames(cfg.csv);
    return new ReplayPriceFeed({ frames, wrap: cfg.wrap });
  }
  throw new Error(`makePriceFeed: unknown kind ${kind}`);
}

/**
 * Clone a world with a fresh RNG seed for nested simulation.
 *
 * The portfolio is deep-cloned; the price feed is cloned with the new
 * seed so the inner walk diverges from the outer's. harnessConfig is
 * shared by reference (it is read-only config).
 *
 * @param {World} world
 * @param {object} opts
 * @param {number} opts.seed
 * @param {string} [opts.tag]
 * @returns {World}
 */
export function cloneWorld(world, opts) {
  return {
    portfolio: world.portfolio.clone(),
    priceFeed: world.priceFeed.clone({ seed: opts.seed }),
    harnessConfig: world.harnessConfig,
    seed: opts.seed,
    tag: opts.tag || `${world.tag}/fork-${opts.seed}`,
  };
}
