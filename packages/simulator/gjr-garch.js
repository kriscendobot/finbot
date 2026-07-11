/**
 * GJR-GARCH(1,1) conditional-volatility surface — the leverage effect.
 *
 * Symmetric GARCH(1,1) (see `garch.js`) reacts to the *magnitude* of the
 * last shock but is blind to its *sign*: a +2σ day and a −2σ day push next
 * tick's variance up by exactly the same amount. Real equity and crypto
 * return series do not behave that way. A large *drop* raises future
 * volatility far more than a large *rise* of the same size — the
 * **leverage effect** (Black 1976): bad news fattens the near-term
 * distribution more than good news. The Glosten–Jagannathan–Runkle (GJR)
 * variant captures it with one extra, sign-gated ARCH term:
 *
 *   sigma^2_{t+1} = omega + (alpha + gamma * I[r_t < 0]) * r_t^2
 *                       + beta * sigma^2_t
 *
 * where I[r_t < 0] is 1 on a down-move and 0 otherwise, and gamma > 0 is
 * the asymmetry. A positive shock contributes `alpha * r_t^2`; a negative
 * shock of the same magnitude contributes `(alpha + gamma) * r_t^2` —
 * strictly more. gamma = 0 collapses exactly onto symmetric GARCH(1,1).
 *
 * Because r_t = sigma_t * z_t with sigma_t > 0, the sign of the realized
 * return is the sign of the standardized innovation z_t. So the indicator
 * keys off the very shock the price feed already hands `nextVariance` —
 * the same post-correlation z_t that moved the price. Like the symmetric
 * surface, GJR draws **zero** RNG of its own and holds only immutable
 * params; the evolving variance lives per feed instance. It is a drop-in
 * `volSurface` (its `isGarch` is true and it exposes the same
 * `has`/`initialVariance`/`nextVariance` interface), so the feed drives it
 * with no code change.
 *
 * Stationarity. With a symmetric innovation (E[z^2] = 1, P(z < 0) = 1/2)
 * the expected ARCH weight is `alpha + gamma/2`, so the persistence is
 *
 *   alpha + beta + gamma/2 < 1
 *
 * and the unconditional variance is `omega / (1 - alpha - beta - gamma/2)`.
 * This is the condition enforced at construction; a request that fails it
 * throws rather than producing an explosive surface.
 */

const DEFAULT_FLOOR = 1e-8;
const DEFAULT_ALPHA = 0.03;
const DEFAULT_GAMMA = 0.09;
const DEFAULT_BETA = 0.9;

/**
 * @typedef {object} GjrGarchParams
 * @property {number} omega     baseline variance (> 0)
 * @property {number} alpha     symmetric ARCH coefficient (>= 0)
 * @property {number} gamma     leverage coefficient — extra ARCH weight on down-moves (alpha + gamma >= 0)
 * @property {number} beta      GARCH coefficient — weight on the last variance (>= 0)
 * @property {number} [sigma0]  starting volatility; defaults to the unconditional vol
 */

/**
 * @typedef {object} GjrGarchStats
 * @property {number} omega
 * @property {number} alpha
 * @property {number} gamma
 * @property {number} beta
 * @property {number} persistence         alpha + beta + gamma/2 (must be < 1)
 * @property {number} unconditionalVol    sqrt(omega / (1 - persistence))
 * @property {number} sigma0              starting volatility
 * @property {number} downWeight          ARCH weight applied to a down-move (alpha + gamma)
 * @property {number} upWeight            ARCH weight applied to an up-move (alpha)
 */

export class GjrGarch11Surface {
  /**
   * @param {Record<string, GjrGarchParams>} params    GJR-GARCH(1,1) params per asset
   * @param {object} [opts]
   * @param {number} [opts.floor]                       clamp conditional variance to at least this (default 1e-8)
   */
  constructor(params, opts = {}) {
    if (!params || typeof params !== 'object') {
      throw new Error('GjrGarch11Surface: params must be a { asset: { omega, alpha, gamma, beta } } map');
    }
    /** @type {Record<string, Required<GjrGarchParams>>} */
    this.params = {};
    for (const [asset, p] of Object.entries(params)) {
      if (!p || typeof p !== 'object') {
        throw new Error(`GjrGarch11Surface: asset ${asset} needs { omega, alpha, gamma, beta }`);
      }
      const omega = p.omega;
      const alpha = p.alpha;
      const gamma = p.gamma != null ? p.gamma : 0;
      const beta = p.beta;
      if (!(omega > 0)) throw new Error(`GjrGarch11Surface: asset ${asset} omega must be > 0`);
      if (!(alpha >= 0)) throw new Error(`GjrGarch11Surface: asset ${asset} alpha must be >= 0`);
      if (!(beta >= 0)) throw new Error(`GjrGarch11Surface: asset ${asset} beta must be >= 0`);
      // The down-move ARCH weight (alpha + gamma) must stay non-negative so
      // a bad-news shock never *reduces* variance; that also admits a mild
      // negative gamma (a reverse-leverage instrument) as long as it does.
      if (!(alpha + gamma >= 0)) {
        throw new Error(`GjrGarch11Surface: asset ${asset} alpha + gamma must be >= 0 (got ${alpha + gamma})`);
      }
      const persistence = alpha + beta + gamma / 2;
      if (!(persistence < 1)) {
        throw new Error(
          `GjrGarch11Surface: asset ${asset} is non-stationary (alpha + beta + gamma/2 = ${persistence} must be < 1)`,
        );
      }
      const uncondVar = omega / (1 - persistence);
      const sigma0 = p.sigma0 != null ? p.sigma0 : Math.sqrt(uncondVar);
      if (!(sigma0 >= 0)) throw new Error(`GjrGarch11Surface: asset ${asset} sigma0 must be >= 0`);
      this.params[asset] = { omega, alpha, gamma, beta, sigma0 };
    }
    this.floor = opts.floor != null ? opts.floor : DEFAULT_FLOOR;
  }

  /**
   * Marks this as a stateful conditional-vol surface so the price feed
   * drives it with the realized shock instead of drawing from a separate
   * empirical bag — same contract as `Garch11Surface`.
   */
  get isGarch() { return true; }

  /** @param {string} asset @returns {boolean} */
  has(asset) { return Object.prototype.hasOwnProperty.call(this.params, asset); }

  /**
   * The variance a fresh trajectory starts from (sigma0^2).
   *
   * @param {string} asset
   * @returns {number}
   */
  initialVariance(asset) {
    const p = this.params[asset];
    if (!p) throw new Error(`GjrGarch11Surface.initialVariance: no params for asset ${asset}`);
    return Math.max(this.floor, p.sigma0 * p.sigma0);
  }

  /**
   * Advance one asset's conditional variance one step given the variance
   * used this tick and the standardized shock z_t that realized this tick.
   * The ARCH weight is `alpha` on an up-move (z_t >= 0) and `alpha + gamma`
   * on a down-move (z_t < 0) — the leverage asymmetry.
   *
   * @param {string} asset
   * @param {number} varNow    sigma^2_t used this tick
   * @param {number} shock     standardized innovation z_t (unit gaussian)
   * @returns {number}         sigma^2_{t+1}, floored
   */
  nextVariance(asset, varNow, shock) {
    const p = this.params[asset];
    if (!p) throw new Error(`GjrGarch11Surface.nextVariance: no params for asset ${asset}`);
    const archWeight = shock < 0 ? p.alpha + p.gamma : p.alpha;
    const next = p.omega + (archWeight * shock * shock + p.beta) * varNow;
    return Math.max(this.floor, next);
  }

  /**
   * @param {string} asset
   * @returns {GjrGarchStats}
   */
  stats(asset) {
    const p = this.params[asset];
    if (!p) throw new Error(`GjrGarch11Surface.stats: no params for asset ${asset}`);
    const persistence = p.alpha + p.beta + p.gamma / 2;
    return {
      omega: p.omega,
      alpha: p.alpha,
      gamma: p.gamma,
      beta: p.beta,
      persistence,
      unconditionalVol: Math.sqrt(p.omega / (1 - persistence)),
      sigma0: p.sigma0,
      downWeight: p.alpha + p.gamma,
      upWeight: p.alpha,
    };
  }
}

/**
 * Fit a GJR-GARCH(1,1) surface to a price-feed history by **variance
 * targeting**, exactly as `garchFromPriceHistory` does for the symmetric
 * model but pinning against the asymmetric persistence. Given the sample
 * variance s^2 of per-tick log returns and a chosen (alpha, gamma, beta),
 *
 *   omega = s^2 * (1 - alpha - beta - gamma/2)
 *
 * so the long-run variance equals s^2. Defaults (alpha = 0.03,
 * gamma = 0.09, beta = 0.90 — persistence 0.975) are typical of daily
 * equity/crypto series: most of the ARCH reaction is carried by the
 * down-move leg, matching the empirical leverage effect. Deterministic, no
 * optimizer; full per-asset MLE of (omega, alpha, gamma, beta) is deferred.
 *
 * Note this fits the *unconditional* variance, not the asymmetry itself —
 * gamma is supplied, not estimated. It reproduces the clustering *and* the
 * sign-asymmetry of the surface without options data or a likelihood
 * search; estimating gamma from the realized down/up variance ratio is the
 * natural next refinement.
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.alpha]     symmetric ARCH coefficient (default 0.03)
 * @param {number} [opts.gamma]     leverage coefficient (default 0.09)
 * @param {number} [opts.beta]      GARCH coefficient (default 0.90)
 * @param {number} [opts.floor]     variance floor (default 1e-8)
 * @returns {GjrGarch11Surface}
 */
export function gjrGarchFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('gjrGarchFromPriceHistory: need at least two price frames');
  }
  const alpha = opts.alpha != null ? opts.alpha : DEFAULT_ALPHA;
  const gamma = opts.gamma != null ? opts.gamma : DEFAULT_GAMMA;
  const beta = opts.beta != null ? opts.beta : DEFAULT_BETA;
  const persistence = alpha + beta + gamma / 2;
  if (!(alpha >= 0 && beta >= 0 && alpha + gamma >= 0 && persistence < 1)) {
    throw new Error(
      `gjrGarchFromPriceHistory: need alpha >= 0, beta >= 0, alpha + gamma >= 0, ` +
        `alpha + beta + gamma/2 < 1 (got alpha=${alpha}, gamma=${gamma}, beta=${beta})`,
    );
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, GjrGarchParams>} */
  const params = {};
  for (const a of assets) {
    const rets = [];
    for (let t = 1; t < priceFrames.length; t += 1) {
      const prev = priceFrames[t - 1][a];
      const cur = priceFrames[t][a];
      if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
    }
    const sampleVar = variance(rets);
    // Guard a degenerate (constant-price) asset: pin a tiny floor so omega
    // stays strictly positive and the surface stays constructible.
    const s2 = sampleVar > 0 ? sampleVar : (opts.floor != null ? opts.floor : DEFAULT_FLOOR);
    params[a] = {
      omega: s2 * (1 - persistence),
      alpha,
      gamma,
      beta,
      sigma0: Math.sqrt(s2),
    };
  }
  return new GjrGarch11Surface(params, { floor: opts.floor });
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
