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
import { surfaceFromPriceHistory } from './vol-surface.js';
import {
  Garch11Surface,
  garchFromPriceHistory,
  garchMleFromPriceHistory,
  autoGjrGarchMleFromPriceHistory,
} from './garch.js';
import {
  GjrGarch11Surface,
  gjrGarchFromPriceHistory,
  gjrGarchMleFromPriceHistory,
} from './gjr-garch.js';

/**
 * @typedef {object} World
 * @property {import('./portfolio.js').Portfolio} portfolio
 * @property {object} priceFeed                       has tick() / current() / clone() / t
 * @property {object} harnessConfig
 * @property {number} seed
 * @property {string} tag
 * @property {Record<string, object>} [instruments]   asset -> live instrument descriptor (yield/dividend accrual)
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
  // Optional instrument registry: asset -> live instrument descriptor (see
  // `yield-accrual.js`). When present, the runner accrues each held
  // yield / dividend position into the portfolio every tick. Absent or
  // all-growth means no accrual and byte-identical price-only behaviour.
  const instruments = cfg.instruments || undefined;
  return { portfolio, priceFeed, harnessConfig, seed, tag, instruments };
}

// Default GARCH / GJR-GARCH parameters, kept in sync with the module-level
// defaults in garch.js / gjr-garch.js so a `volatilities`-only descriptor
// (variance-targeting from a base vol) matches what the from-history fitters
// would produce for the same target. Typical daily-series persistence.
const GARCH_DEFAULTS = { alpha: 0.08, beta: 0.9 };
const GJR_DEFAULTS = { alpha: 0.03, gamma: 0.09, beta: 0.9 };

/**
 * Build a conditional / empirical volatility surface from a plain config
 * descriptor, so a caller that only holds config (the OODA pipeline's world
 * builder) can request GARCH volatility clustering without importing the
 * surface constructors itself.
 *
 * Accepts, and returns unchanged, an already-constructed surface (anything
 * exposing `nextVariance` or `sample`), so `makePriceFeed` can route every
 * `volSurface` value through here uniformly.
 *
 * Descriptor shapes (`{ kind, ... }`):
 *   - `{ kind: 'garch', params }`         explicit per-asset { omega, alpha, beta }
 *   - `{ kind: 'garch', history }`        fit by variance targeting from price frames
 *   - `{ kind: 'garch', history, estimate: 'mle' }`  as above, but estimate (alpha,
 *                                          beta) per asset from the data (light MLE)
 *   - `{ kind: 'garch', volatilities }`   variance-target from a per-asset base sigma
 *   - `{ kind: 'gjr-garch', ... }`        same four forms, with a leverage `gamma`;
 *                                          `estimate: 'mle'` fits (alpha, gamma, beta)
 *   - `{ kind: 'auto-gjr-garch', history }` fit both MLEs and choose GJR per asset
 *                                          only when its fitted `gamma` clears `gammaThreshold`
 *   - `{ kind: 'empirical', history }`    empirical bootstrap of realized vol
 * `alpha` / `beta` / `gamma` / `floor` on the descriptor override the defaults.
 *
 * @param {object|null|undefined} descriptor
 * @returns {object|null}  a surface (isGarch or empirical) or null
 */
export function makeVolSurface(descriptor) {
  if (descriptor == null) return null;
  // Already a constructed surface — pass through untouched.
  if (typeof descriptor.nextVariance === 'function' || typeof descriptor.sample === 'function') {
    return descriptor;
  }
  const kind = descriptor.kind || 'empirical';
  const floor = descriptor.floor;

  if (kind === 'auto-gjr-garch') {
    if (!descriptor.history) {
      throw new Error("makeVolSurface: an 'auto-gjr-garch' descriptor needs a { history } of price frames");
    }
    return autoGjrGarchMleFromPriceHistory(descriptor.history, descriptor);
  }

  if (kind === 'garch' || kind === 'gjr-garch') {
    const gjr = kind === 'gjr-garch';
    if (descriptor.params) {
      return gjr
        ? new GjrGarch11Surface(descriptor.params, { floor })
        : new Garch11Surface(descriptor.params, { floor });
    }
    if (descriptor.history) {
      if (descriptor.estimate === 'mle') {
        return gjr
          ? gjrGarchMleFromPriceHistory(descriptor.history, descriptor)
          : garchMleFromPriceHistory(descriptor.history, descriptor);
      }
      return gjr
        ? gjrGarchFromPriceHistory(descriptor.history, descriptor)
        : garchFromPriceHistory(descriptor.history, descriptor);
    }
    if (descriptor.volatilities) {
      return volSurfaceFromBaseVol(descriptor.volatilities, descriptor, gjr, floor);
    }
    throw new Error(
      `makeVolSurface: a '${kind}' descriptor needs one of { params, history, volatilities }`,
    );
  }
  if (kind === 'empirical') {
    if (!descriptor.history) {
      throw new Error("makeVolSurface: an 'empirical' descriptor needs a { history } of price frames");
    }
    return surfaceFromPriceHistory(descriptor.history, descriptor);
  }
  throw new Error(`makeVolSurface: unknown volSurface kind '${kind}'`);
}

/**
 * Variance-target a GARCH / GJR-GARCH surface directly from a per-asset base
 * volatility: pin each asset's unconditional variance to sigma^2, take the
 * ARCH/GARCH (and leverage) split from the descriptor or the defaults. This
 * is the same variance-targeting the from-history fitters do, sourced from a
 * base vol rather than a return sample — the ergonomic form for a driver that
 * already holds a per-asset vol.
 *
 * @param {Record<string, number>} volatilities   asset -> base sigma
 * @param {object} opts                            alpha / beta / gamma overrides
 * @param {boolean} gjr                            build the asymmetric surface
 * @param {number} [floor]
 * @returns {Garch11Surface | GjrGarch11Surface}
 */
function volSurfaceFromBaseVol(volatilities, opts, gjr, floor) {
  const alpha = opts.alpha != null ? opts.alpha : (gjr ? GJR_DEFAULTS.alpha : GARCH_DEFAULTS.alpha);
  const beta = opts.beta != null ? opts.beta : (gjr ? GJR_DEFAULTS.beta : GARCH_DEFAULTS.beta);
  const gamma = opts.gamma != null ? opts.gamma : GJR_DEFAULTS.gamma;
  const persistence = gjr ? alpha + beta + gamma / 2 : alpha + beta;
  const params = {};
  for (const [asset, sigma] of Object.entries(volatilities)) {
    const s2 = sigma * sigma;
    params[asset] = gjr
      ? { omega: s2 * (1 - persistence), alpha, gamma, beta, sigma0: sigma }
      : { omega: s2 * (1 - persistence), alpha, beta, sigma0: sigma };
  }
  return gjr ? new GjrGarch11Surface(params, { floor }) : new Garch11Surface(params, { floor });
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
      volSurface: makeVolSurface(cfg.volSurface),
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
    // The instrument registry is read-only config; share it by reference so a
    // forked world accrues yield on the same descriptors the parent does.
    instruments: world.instruments,
  };
}
