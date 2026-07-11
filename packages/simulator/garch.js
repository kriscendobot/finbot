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
