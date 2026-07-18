/**
 * GARCH(1,1) conditional-volatility surface.
 *
 * The empirical `VolatilitySurface` (see `vol-surface.js`) draws a fresh
 * sigma per tick *independently* from a fixed bag of realized-vol
 * observations. That widens the tails toward the historical record but
 * throws away the one property that most distinguishes real financial
 * return series from iid noise: **volatility clustering** — calm begets
 * calm, a large move begets more large moves. GARCH(1,1) models exactly
 * that. The conditional variance evolves
 *
 *   sigma^2_{t+1} = omega + alpha * r_t^2 + beta * sigma^2_t
 *                 = omega + (alpha * z_t^2 + beta) * sigma^2_t
 *
 * where r_t = sigma_t * z_t is this tick's realized return shock and
 * z_t ~ N(0,1) is the standardized innovation. A large |z_t| pushes next
 * tick's variance up; a run of small shocks lets it decay back toward the
 * unconditional level omega / (1 - alpha - beta). alpha + beta is the
 * *persistence*; it must be < 1 for the process to be stationary (mean
 * reverting) rather than explosive.
 *
 * Unlike the empirical surface, GARCH is *stateful*: the sigma it vends
 * this tick depends on the whole realized path so far. That state lives
 * in the price feed (one evolving variance per asset per feed instance),
 * not in this surface — the surface holds only the immutable parameters,
 * exactly as the fixed `volatilities` config does. So a single
 * `Garch11Surface` is safely shared across every child of a forecast
 * ensemble: each fork starts a fresh variance path from
 * `initialVariance()` and drives it with that child's own price shocks.
 *
 * The determinism contract holds without any extra RNG stream: the GARCH
 * recursion reuses the feed's *existing* per-asset price shock (the same
 * `z_t` that moved the price, post-correlation), so it draws zero numbers
 * of its own. Same seed + same params -> byte-identical variance path.
 */

import { gjrGarchFromPriceHistory, gjrGarchMleFromPriceHistory } from './gjr-garch.js';
import { egarchFromPriceHistory, egarchMleFromPriceHistory } from './egarch.js';

const DEFAULT_FLOOR = 1e-8;
const DEFAULT_ALPHA = 0.08;
const DEFAULT_BETA = 0.9;

/**
 * @typedef {object} GarchParams
 * @property {number} omega     baseline variance (> 0)
 * @property {number} alpha     ARCH coefficient — weight on the last squared shock (>= 0)
 * @property {number} beta      GARCH coefficient — weight on the last variance (>= 0)
 * @property {number} [sigma0]  starting volatility; defaults to the unconditional vol
 */

/**
 * @typedef {object} GarchStats
 * @property {number} omega
 * @property {number} alpha
 * @property {number} beta
 * @property {number} persistence         alpha + beta (must be < 1)
 * @property {number} unconditionalVol    sqrt(omega / (1 - alpha - beta))
 * @property {number} sigma0              starting volatility
 */

export class Garch11Surface {
  /**
   * @param {Record<string, GarchParams>} params    GARCH(1,1) params per asset
   * @param {object} [opts]
   * @param {number} [opts.floor]                    clamp conditional vol to at least this (default 1e-8 on variance)
   */
  constructor(params, opts = {}) {
    if (!params || typeof params !== 'object') {
      throw new Error('Garch11Surface: params must be a { asset: { omega, alpha, beta } } map');
    }
    /** @type {Record<string, Required<GarchParams>>} */
    this.params = {};
    for (const [asset, p] of Object.entries(params)) {
      if (!p || typeof p !== 'object') {
        throw new Error(`Garch11Surface: asset ${asset} needs { omega, alpha, beta }`);
      }
      const omega = p.omega;
      const alpha = p.alpha;
      const beta = p.beta;
      if (!(omega > 0)) throw new Error(`Garch11Surface: asset ${asset} omega must be > 0`);
      if (!(alpha >= 0)) throw new Error(`Garch11Surface: asset ${asset} alpha must be >= 0`);
      if (!(beta >= 0)) throw new Error(`Garch11Surface: asset ${asset} beta must be >= 0`);
      if (!(alpha + beta < 1)) {
        throw new Error(
          `Garch11Surface: asset ${asset} is non-stationary (alpha + beta = ${alpha + beta} must be < 1)`,
        );
      }
      const uncondVar = omega / (1 - alpha - beta);
      const sigma0 = p.sigma0 != null ? p.sigma0 : Math.sqrt(uncondVar);
      if (!(sigma0 >= 0)) throw new Error(`Garch11Surface: asset ${asset} sigma0 must be >= 0`);
      this.params[asset] = { omega, alpha, beta, sigma0 };
    }
    this.floor = opts.floor != null ? opts.floor : DEFAULT_FLOOR;
  }

  /**
   * Marks this as a stateful conditional-vol surface so the price feed
   * drives it with the realized shock instead of drawing from a separate
   * empirical bag. Kept as a property (not duck-typed on method names) so
   * the distinction reads at the call site.
   */
  get isGarch() { return true; }

  /** @param {string} asset @returns {boolean} */
  has(asset) { return Object.prototype.hasOwnProperty.call(this.params, asset); }

  /**
   * The variance a fresh trajectory starts from (sigma0^2). Every fork of
   * a forecast ensemble seeds its own evolving variance from here.
   *
   * @param {string} asset
   * @returns {number}
   */
  initialVariance(asset) {
    const p = this.params[asset];
    if (!p) throw new Error(`Garch11Surface.initialVariance: no params for asset ${asset}`);
    return Math.max(this.floor, p.sigma0 * p.sigma0);
  }

  /**
   * Advance one asset's conditional variance one step given the variance
   * used this tick and the standardized shock z_t that realized this tick.
   *
   *   sigma^2_{t+1} = omega + alpha * z_t^2 * sigma^2_t + beta * sigma^2_t
   *
   * @param {string} asset
   * @param {number} varNow    sigma^2_t used this tick
   * @param {number} shock     standardized innovation z_t (unit gaussian)
   * @returns {number}         sigma^2_{t+1}, floored
   */
  nextVariance(asset, varNow, shock) {
    const p = this.params[asset];
    if (!p) throw new Error(`Garch11Surface.nextVariance: no params for asset ${asset}`);
    const next = p.omega + (p.alpha * shock * shock + p.beta) * varNow;
    return Math.max(this.floor, next);
  }

  /**
   * @param {string} asset
   * @returns {GarchStats}
   */
  stats(asset) {
    const p = this.params[asset];
    if (!p) throw new Error(`Garch11Surface.stats: no params for asset ${asset}`);
    const persistence = p.alpha + p.beta;
    return {
      omega: p.omega,
      alpha: p.alpha,
      beta: p.beta,
      persistence,
      unconditionalVol: Math.sqrt(p.omega / (1 - persistence)),
      sigma0: p.sigma0,
    };
  }
}

/**
 * Fit a GARCH(1,1) surface to a price-feed history by **variance
 * targeting**: pin the model's unconditional variance to the sample
 * variance of per-tick log returns, and take the ARCH/GARCH split
 * (alpha, beta) from configuration rather than a full maximum-likelihood
 * search. Given the sample variance s^2 and a chosen (alpha, beta),
 *
 *   omega = s^2 * (1 - alpha - beta)
 *
 * so the long-run variance equals s^2 exactly. Defaults (alpha = 0.08,
 * beta = 0.90, persistence 0.98) are typical of daily financial series —
 * high persistence, modest reaction. Full MLE estimation of (omega,
 * alpha, beta) per asset is deferred; variance targeting is deterministic,
 * needs no optimizer, and captures the clustering the empirical surface
 * cannot. The starting volatility is the sample vol, so a fresh path
 * begins at the historical average and clusters away from it.
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.alpha]     ARCH coefficient (default 0.08)
 * @param {number} [opts.beta]      GARCH coefficient (default 0.90)
 * @param {number} [opts.floor]     variance floor (default 1e-8)
 * @returns {Garch11Surface}
 */
export function garchFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('garchFromPriceHistory: need at least two price frames');
  }
  const alpha = opts.alpha != null ? opts.alpha : DEFAULT_ALPHA;
  const beta = opts.beta != null ? opts.beta : DEFAULT_BETA;
  if (!(alpha >= 0 && beta >= 0 && alpha + beta < 1)) {
    throw new Error(`garchFromPriceHistory: need alpha >= 0, beta >= 0, alpha + beta < 1 (got ${alpha}, ${beta})`);
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, GarchParams>} */
  const params = {};
  for (const a of assets) {
    const rets = [];
    for (let t = 1; t < priceFrames.length; t += 1) {
      const prev = priceFrames[t - 1][a];
      const cur = priceFrames[t][a];
      if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
    }
    const sampleVar = variance(rets);
    // Guard a degenerate (constant-price) asset: pin a tiny floor so
    // omega stays strictly positive and the surface stays constructible.
    const s2 = sampleVar > 0 ? sampleVar : (opts.floor != null ? opts.floor : DEFAULT_FLOOR);
    params[a] = {
      omega: s2 * (1 - alpha - beta),
      alpha,
      beta,
      sigma0: Math.sqrt(s2),
    };
  }
  return new Garch11Surface(params, { floor: opts.floor });
}

// --- Variance-targeting maximum-likelihood estimation of (alpha, beta) --------
//
// `garchFromPriceHistory` pins the unconditional variance to the sample variance
// but takes the ARCH/GARCH split (alpha, beta) from configuration. That models
// *how much* the series varies but not *how it clusters* — a calm, mean-reverting
// asset and a bursty, highly-persistent one get the same 0.08/0.90 shape. The
// estimator below reads the clustering out of the data: holding the unconditional
// variance pinned at the sample variance (variance targeting), it searches (alpha,
// beta) to maximize the Gaussian likelihood of the conditional-variance recursion.
//
// The search is a **deterministic nested grid refinement** — a coarse grid over
// the (alpha, beta) box, then successively finer grids around the best cell — so
// it needs no optimizer library, draws no RNG, and returns byte-identical params
// for identical input. It is a *light* MLE: full BFGS/Newton MLE of (omega, alpha,
// beta) jointly is deferred; variance targeting removes omega from the search
// (omega = s^2 * (1 - alpha - beta)) so only the two persistence coefficients are
// fit, which is both cheaper and more stable on the short windows the OODA cycle
// observes.

const MLE_ALPHA_BOUNDS = [1e-4, 0.6];
const MLE_BETA_BOUNDS = [0.0, 0.999];
const MLE_MAX_PERSISTENCE = 0.9995;
const MLE_GRID = 8;      // points per axis per refinement level
const MLE_LEVELS = 5;    // refinement levels
const MLE_MIN_RETURNS = 12; // below this a per-window MLE is too noisy → fixed split

// The automatic asymmetric-model gate deliberately has the same evidence
// floor as the MLE itself. A short-window MLE falls back to configured GJR
// defaults, which is useful for an explicitly requested GJR model but is not
// evidence that this asset has a leverage effect.
const AUTO_GJR_MIN_RETURNS = MLE_MIN_RETURNS;
const AUTO_GJR_GAMMA_THRESHOLD = 0.05;
const AUTO_EGARCH_MIN_RETURNS = MLE_MIN_RETURNS;
const AUTO_EGARCH_GAMMA_THRESHOLD = 0.05;

/**
 * Gaussian negative log-likelihood of a variance-targeting GARCH(1,1) with the
 * given (alpha, beta), evaluated on a demeaned return series. omega is pinned so
 * the unconditional variance equals `sampleVar`. The conditional variance starts
 * at the unconditional level and evolves by the GARCH recursion; each return is
 * scored under its conditional variance. Returns +Infinity for a parameterization
 * that makes omega non-positive or the variance collapse (so the search rejects it).
 *
 * @param {number[]} rets       demeaned log returns
 * @param {number} sampleVar    sample variance the model is targeted to
 * @param {number} alpha
 * @param {number} beta
 * @returns {number}            sum of per-observation NLL contributions
 */
function garchNegLogLik(rets, sampleVar, alpha, beta) {
  const omega = sampleVar * (1 - alpha - beta);
  if (!(omega > 0)) return Infinity;
  let h = sampleVar; // start at the unconditional variance
  let nll = 0;
  for (let t = 0; t < rets.length; t += 1) {
    if (!(h > 0)) return Infinity;
    const r2 = rets[t] * rets[t];
    nll += 0.5 * (Math.log(h) + r2 / h);
    h = omega + alpha * r2 + beta * h;
  }
  return nll;
}

/**
 * Estimate (alpha, beta) for one asset by maximizing the variance-targeting
 * Gaussian likelihood over the demeaned returns, via deterministic nested grid
 * refinement. Falls back to the fixed defaults when the window is too short for a
 * per-window fit to mean anything.
 *
 * @param {number[]} rets       demeaned log returns
 * @param {number} sampleVar
 * @param {object} [opts]
 * @param {number} [opts.alpha]  default split (fallback / seed)
 * @param {number} [opts.beta]
 * @returns {{ alpha: number, beta: number }}
 */
function estimateGarchParams(rets, sampleVar, opts = {}) {
  const fallbackAlpha = opts.alpha != null ? opts.alpha : DEFAULT_ALPHA;
  const fallbackBeta = opts.beta != null ? opts.beta : DEFAULT_BETA;
  if (rets.length < MLE_MIN_RETURNS || !(sampleVar > 0)) {
    return { alpha: fallbackAlpha, beta: fallbackBeta };
  }
  let aLo = MLE_ALPHA_BOUNDS[0];
  let aHi = MLE_ALPHA_BOUNDS[1];
  let bLo = MLE_BETA_BOUNDS[0];
  let bHi = MLE_BETA_BOUNDS[1];
  let best = { alpha: fallbackAlpha, beta: fallbackBeta, nll: Infinity };
  for (let level = 0; level < MLE_LEVELS; level += 1) {
    for (let i = 0; i <= MLE_GRID; i += 1) {
      const alpha = aLo + ((aHi - aLo) * i) / MLE_GRID;
      for (let j = 0; j <= MLE_GRID; j += 1) {
        const beta = bLo + ((bHi - bLo) * j) / MLE_GRID;
        if (alpha < 0 || beta < 0) continue;
        if (alpha + beta > MLE_MAX_PERSISTENCE) continue;
        const nll = garchNegLogLik(rets, sampleVar, alpha, beta);
        // Strict `<` keeps the tie-break deterministic (first — i.e. lowest
        // alpha then lowest beta — wins), independent of iteration platform.
        if (nll < best.nll) best = { alpha, beta, nll };
      }
    }
    if (!Number.isFinite(best.nll)) return { alpha: fallbackAlpha, beta: fallbackBeta };
    // Refine one grid cell around the incumbent on each axis.
    const aStep = (aHi - aLo) / MLE_GRID;
    const bStep = (bHi - bLo) / MLE_GRID;
    aLo = Math.max(MLE_ALPHA_BOUNDS[0], best.alpha - aStep);
    aHi = Math.min(MLE_ALPHA_BOUNDS[1], best.alpha + aStep);
    bLo = Math.max(MLE_BETA_BOUNDS[0], best.beta - bStep);
    bHi = Math.min(MLE_BETA_BOUNDS[1], best.beta + bStep);
  }
  return { alpha: best.alpha, beta: best.beta };
}

/**
 * Fit a GARCH(1,1) surface to a price history the same way
 * `garchFromPriceHistory` does — variance targeting pins the unconditional
 * variance to the sample variance — but **estimate (alpha, beta) per asset from
 * the data** (light variance-targeting MLE) instead of taking a single fixed
 * split for every asset. So a bursty, highly-persistent instrument and a calm,
 * quickly mean-reverting one get different clustering shapes read from their own
 * realized returns, not one config default imposed on both.
 *
 * Deterministic (grid search, no RNG; same frames → same params) and robust: an
 * asset with too few returns for a meaningful per-window fit, or a degenerate
 * constant-price asset, falls back to the fixed default split exactly as
 * `garchFromPriceHistory` would. `opts.alpha` / `opts.beta` set that fallback.
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.alpha]     fallback ARCH coefficient (default 0.08)
 * @param {number} [opts.beta]      fallback GARCH coefficient (default 0.90)
 * @param {number} [opts.floor]     variance floor (default 1e-8)
 * @returns {Garch11Surface}
 */
export function garchMleFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('garchMleFromPriceHistory: need at least two price frames');
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, GarchParams>} */
  const params = {};
  for (const a of assets) {
    const rets = [];
    for (let t = 1; t < priceFrames.length; t += 1) {
      const prev = priceFrames[t - 1][a];
      const cur = priceFrames[t][a];
      if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
    }
    const sampleVar = variance(rets);
    const s2 = sampleVar > 0 ? sampleVar : (opts.floor != null ? opts.floor : DEFAULT_FLOOR);
    // Estimate on demeaned returns so the fit targets the variance, not the drift.
    const mean = rets.length ? rets.reduce((acc, x) => acc + x, 0) / rets.length : 0;
    const demeaned = rets.map((x) => x - mean);
    const { alpha, beta } = estimateGarchParams(demeaned, sampleVar, opts);
    params[a] = {
      omega: s2 * (1 - alpha - beta),
      alpha,
      beta,
      sigma0: Math.sqrt(s2),
    };
  }
  return new Garch11Surface(params, { floor: opts.floor });
}

/**
 * A per-asset selector between symmetric GARCH and asymmetric GJR-GARCH.
 * Both candidate surfaces are fitted from the same history. An asset takes the
 * GJR branch only when its data-supported GJR MLE estimates a materially
 * positive gamma; otherwise it keeps the simpler symmetric model. This lets a
 * mixed portfolio model leverage where it is observed without imposing it on
 * every instrument.
 */
export class AutoGjrGarchSurface {
  /**
   * @param {Garch11Surface} garch
   * @param {import('./gjr-garch.js').GjrGarch11Surface} gjr
   * @param {Record<string, number>} returnCounts
   * @param {object} [opts]
   * @param {number} [opts.gammaThreshold]
   */
  constructor(garch, gjr, returnCounts, opts = {}) {
    this.garch = garch;
    this.gjr = gjr;
    this.gammaThreshold = opts.gammaThreshold != null
      ? opts.gammaThreshold
      : AUTO_GJR_GAMMA_THRESHOLD;
    if (!(this.gammaThreshold >= 0)) {
      throw new Error('AutoGjrGarchSurface: gammaThreshold must be >= 0');
    }
    this.selected = {};
    for (const asset of Object.keys(returnCounts)) {
      if (!garch.has(asset) || !gjr.has(asset)) continue;
      const gamma = gjr.stats(asset).gamma;
      this.selected[asset] = returnCounts[asset] >= AUTO_GJR_MIN_RETURNS
        && gamma >= this.gammaThreshold
        ? gjr
        : garch;
    }
  }

  get isGarch() { return true; }

  /** @param {string} asset @returns {boolean} */
  has(asset) { return Object.prototype.hasOwnProperty.call(this.selected, asset); }

  /** @param {string} asset @returns {number} */
  initialVariance(asset) { return this.surfaceFor(asset).initialVariance(asset); }

  /** @param {string} asset @param {number} varNow @param {number} shock @returns {number} */
  nextVariance(asset, varNow, shock) { return this.surfaceFor(asset).nextVariance(asset, varNow, shock); }

  /** @param {string} asset @returns {object} */
  stats(asset) {
    const surface = this.surfaceFor(asset);
    return {
      ...surface.stats(asset),
      model: surface === this.gjr ? 'gjr-garch' : 'garch',
    };
  }

  /** @param {string} asset */
  surfaceFor(asset) {
    const surface = this.selected[asset];
    if (!surface) throw new Error(`AutoGjrGarchSurface: no params for asset ${asset}`);
    return surface;
  }
}

/**
 * Fit both symmetric and asymmetric variance-targeting MLEs, then choose the
 * asymmetric surface per asset only when measured leverage clears the material
 * gamma threshold. The return-count guard prevents a GJR fallback default from
 * being mistaken for fitted evidence on a short or invalid history.
 *
 * @param {Array<Record<string, number>>} priceFrames
 * @param {object} [opts]
 * @param {number} [opts.gammaThreshold] minimum fitted gamma for the GJR branch (default 0.05)
 * @returns {AutoGjrGarchSurface}
 */
export function autoGjrGarchMleFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('autoGjrGarchMleFromPriceHistory: need at least two price frames');
  }
  const returnCounts = {};
  for (const asset of Object.keys(priceFrames[0])) {
    let count = 0;
    for (let t = 1; t < priceFrames.length; t += 1) {
      if (priceFrames[t - 1][asset] > 0 && priceFrames[t][asset] > 0) count += 1;
    }
    returnCounts[asset] = count;
  }
  return new AutoGjrGarchSurface(
    garchMleFromPriceHistory(priceFrames, opts),
    gjrGarchMleFromPriceHistory(priceFrames, opts),
    returnCounts,
    opts,
  );
}

/**
 * A per-asset selector between symmetric GARCH and log-variance EGARCH.
 * EGARCH is selected only when its fitted signed leverage coefficient has a
 * material magnitude. The absolute-value gate deliberately accepts both the
 * usual leverage sign (gamma < 0) and reverse leverage (gamma > 0), which the
 * EGARCH surface can represent. As with the GJR selector, a short-window
 * fallback must never count as evidence.
 */
export class AutoEgarchSurface {
  /**
   * @param {Garch11Surface} garch
   * @param {import('./egarch.js').Egarch11Surface} egarch
   * @param {Record<string, number>} returnCounts
   * @param {object} [opts]
   * @param {number} [opts.gammaThreshold]
   */
  constructor(garch, egarch, returnCounts, opts = {}) {
    this.garch = garch;
    this.egarch = egarch;
    this.gammaThreshold = opts.gammaThreshold != null
      ? opts.gammaThreshold
      : AUTO_EGARCH_GAMMA_THRESHOLD;
    if (!(this.gammaThreshold >= 0)) {
      throw new Error('AutoEgarchSurface: gammaThreshold must be >= 0');
    }
    this.selected = {};
    for (const asset of Object.keys(returnCounts)) {
      if (!garch.has(asset) || !egarch.has(asset)) continue;
      const gamma = egarch.stats(asset).gamma;
      this.selected[asset] = returnCounts[asset] >= AUTO_EGARCH_MIN_RETURNS
        && Math.abs(gamma) >= this.gammaThreshold
        ? egarch
        : garch;
    }
  }

  get isGarch() { return true; }

  /** @param {string} asset @returns {boolean} */
  has(asset) { return Object.prototype.hasOwnProperty.call(this.selected, asset); }

  /** @param {string} asset @returns {number} */
  initialVariance(asset) { return this.surfaceFor(asset).initialVariance(asset); }

  /** @param {string} asset @param {number} varNow @param {number} shock @returns {number} */
  nextVariance(asset, varNow, shock) { return this.surfaceFor(asset).nextVariance(asset, varNow, shock); }

  /** @param {string} asset @returns {object} */
  stats(asset) {
    const surface = this.surfaceFor(asset);
    return {
      ...surface.stats(asset),
      model: surface === this.egarch ? 'egarch' : 'garch',
    };
  }

  /** @param {string} asset */
  surfaceFor(asset) {
    const surface = this.selected[asset];
    if (!surface) throw new Error(`AutoEgarchSurface: no params for asset ${asset}`);
    return surface;
  }
}

/**
 * Fit symmetric GARCH and EGARCH MLEs from the same window, then choose the
 * EGARCH branch per asset when its fitted signed gamma is material. This keeps
 * the simpler GARCH recursion for assets without measured asymmetry while
 * letting either leverage sign reach the live regime read and forecast.
 *
 * @param {Array<Record<string, number>>} priceFrames
 * @param {object} [opts]
 * @param {number} [opts.gammaThreshold] minimum absolute fitted gamma for EGARCH (default 0.05)
 * @returns {AutoEgarchSurface}
 */
export function autoEgarchMleFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('autoEgarchMleFromPriceHistory: need at least two price frames');
  }
  const returnCounts = {};
  for (const asset of Object.keys(priceFrames[0])) {
    let count = 0;
    for (let t = 1; t < priceFrames.length; t += 1) {
      if (priceFrames[t - 1][asset] > 0 && priceFrames[t][asset] > 0) count += 1;
    }
    returnCounts[asset] = count;
  }
  return new AutoEgarchSurface(
    garchMleFromPriceHistory(priceFrames, opts),
    egarchMleFromPriceHistory(priceFrames, opts),
    returnCounts,
    opts,
  );
}

/**
 * @typedef {object} RegimeRead
 * @property {number} conditionalVol   sqrt of the variance the model carries into the NEXT tick
 * @property {number} unconditionalVol the long-run level sqrt(omega / (1 - persistence))
 * @property {number} persistence      alpha + beta (how slowly an elevated regime decays)
 * @property {number} sigma0           the variance a fresh trajectory starts from, as a vol
 * @property {number} alpha
 * @property {number} beta
 * @property {number} [gamma]          leverage coefficient — present only for a GJR (asymmetric) read
 */

/**
 * Read the *current* volatility regime out of an observed window: fit a
 * GARCH(1,1) surface (variance targeting, optionally with a per-asset MLE of
 * the (alpha, beta) split) and roll each asset's conditional variance forward
 * over its own realized (demeaned) returns, ending at the variance the model
 * carries into the NEXT tick. That terminal conditional volatility is the
 * regime read a scorer wants: after a burst of shocks a highly-persistent
 * asset's conditional vol sits ABOVE its unconditional level (elevated,
 * lingering risk); in the calm after a storm it sits BELOW — neither of which
 * the window-averaged realized (unconditional) vol can see.
 *
 * The recursion reuses the fitted surface's own `initialVariance`/`nextVariance`,
 * so the regime read matches the engine the forecaster projects the ensemble
 * under (same clustering, same params). Deterministic end to end: the fit is
 * variance targeting / a deterministic grid search and the roll-forward is a
 * plain recursion — no RNG — so a score that folds this in stays reproducible.
 *
 * Symmetric vs. asymmetric. By default the surface is the sign-blind
 * GARCH(1,1); `kind: 'gjr-garch'` and `kind: 'egarch'` roll the read forward
 * under the two asymmetric forms. `kind: 'auto-gjr-garch'` and
 * `kind: 'auto-egarch'` choose their asymmetric candidate per asset only when
 * the fitted gamma is material. Every surface exposes the identical
 * `initialVariance`/`nextVariance`/`stats` interface, so only the fit differs;
 * the roll-forward recursion below is untouched. An asymmetric read carries
 * `gamma` in each per-asset entry (absent from a symmetric read).
 *
 * @param {Array<Record<string, number>>} priceFrames  per-tick { asset: price }
 * @param {object} [opts]
 * @param {'garch'|'gjr-garch'|'egarch'|'auto-gjr-garch'|'auto-egarch'} [opts.kind]  auto kinds select their asymmetric candidate per asset only when fitted gamma is material
 * @param {'mle'|'fixed'} [opts.estimate]  'mle' fits the params per asset; else the fixed split
 * @param {number} [opts.alpha]  fixed / fallback ARCH coefficient
 * @param {number} [opts.gamma]  fixed / fallback leverage coefficient (gjr-garch only)
 * @param {number} [opts.beta]   fixed / fallback GARCH coefficient
 * @param {number} [opts.floor]  variance floor
 * @returns {Record<string, RegimeRead>}   per-asset regime read (assets the surface could not host are omitted)
 */
export function conditionalVolFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('conditionalVolFromPriceHistory: need at least two price frames');
  }
  const autoGjr = opts.kind === 'auto-gjr-garch';
  const autoEgarch = opts.kind === 'auto-egarch';
  const gjr = opts.kind === 'gjr-garch';
  const egarch = opts.kind === 'egarch';
  const mle = opts.estimate === 'mle';
  let surface;
  if (autoGjr) {
    surface = autoGjrGarchMleFromPriceHistory(priceFrames, opts);
  } else if (autoEgarch) {
    surface = autoEgarchMleFromPriceHistory(priceFrames, opts);
  } else if (gjr) {
    surface = mle
      ? gjrGarchMleFromPriceHistory(priceFrames, opts)
      : gjrGarchFromPriceHistory(priceFrames, opts);
  } else if (egarch) {
    surface = mle
      ? egarchMleFromPriceHistory(priceFrames, opts)
      : egarchFromPriceHistory(priceFrames, opts);
  } else {
    surface = mle
      ? garchMleFromPriceHistory(priceFrames, opts)
      : garchFromPriceHistory(priceFrames, opts);
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, RegimeRead>} */
  const out = {};
  for (const a of assets) {
    if (!surface.has(a)) continue;
    const rets = [];
    for (let t = 1; t < priceFrames.length; t += 1) {
      const prev = priceFrames[t - 1][a];
      const cur = priceFrames[t][a];
      if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
    }
    // Demean so the roll-forward tracks variance, not drift — matching the
    // way the MLE fitter scores its returns.
    const mean = rets.length ? rets.reduce((acc, x) => acc + x, 0) / rets.length : 0;
    let h = surface.initialVariance(a);
    for (const r of rets) {
      const sd = Math.sqrt(h);
      // z_t = r_t / sigma_t; nextVariance(...,z) reproduces the variance-form
      // recursion sigma^2_{t+1} = omega + alpha*r_t^2 + beta*sigma^2_t.
      const shock = sd > 0 ? (r - mean) / sd : 0;
      h = surface.nextVariance(a, h, shock);
    }
    const st = surface.stats(a);
    out[a] = {
      conditionalVol: Math.sqrt(h),
      unconditionalVol: st.unconditionalVol,
      persistence: st.persistence,
      sigma0: st.sigma0,
      alpha: st.alpha,
      beta: st.beta,
    };
    // A GJR (asymmetric) surface also reports the leverage coefficient; carry
    // it through so a scorer can tell an asymmetric read from a symmetric one.
    if (st.gamma != null) out[a].gamma = st.gamma;
    if (st.model != null) out[a].model = st.model;
  }
  return out;
}

/**
 * Sample variance (divisor n-1) of a return series; 0 for < 2 points.
 *
 * @param {number[]} xs
 * @returns {number}
 */
function variance(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((acc, x) => acc + x, 0) / n;
  return xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1);
}
