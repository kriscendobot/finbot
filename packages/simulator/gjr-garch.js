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

// --- Variance-targeting maximum-likelihood estimation of (alpha, gamma, beta) --
//
// `gjrGarchFromPriceHistory` pins the unconditional variance to the sample
// variance but takes the ARCH split *and the leverage gamma* from configuration.
// That models *how much* the series varies but not *how asymmetrically it
// clusters* — a symmetric, magnitude-only instrument and a leverage-heavy one
// (a big drop stokes far more forward vol than a big rise) get the same fixed
// gamma. The estimator below reads the asymmetry out of the data: holding the
// unconditional variance pinned at the sample variance (variance targeting), it
// searches (alpha, gamma, beta) to maximize the Gaussian likelihood of the
// sign-gated GJR conditional-variance recursion. gamma emerges from the realized
// down/up variance ratio rather than a config default — the refinement the
// `gjrGarchFromPriceHistory` doc names as "the natural next" one.
//
// Like the symmetric fitter (`garchMleFromPriceHistory`) the search is a
// **deterministic nested grid refinement**: a coarse grid over the (alpha, gamma,
// beta) box, then successively finer grids around the best cell — no optimizer
// library, no RNG, byte-identical params for identical input. It is a *light* MLE:
// variance targeting removes omega from the search (omega = s^2 * (1 - alpha -
// beta - gamma/2)) so only the three persistence coefficients are fit, which is
// both cheaper and more stable on the short windows the OODA cycle observes. gamma
// is bounded non-negative — the standard leverage sign — so the fit stays
// identified on the ~half of the sample that is down-moves; the fixed-config path
// still admits a mild reverse-leverage (negative) gamma.

const MLE_ALPHA_BOUNDS = [0.0, 0.6];
const MLE_GAMMA_BOUNDS = [0.0, 0.6];
const MLE_BETA_BOUNDS = [0.0, 0.999];
const MLE_MAX_PERSISTENCE = 0.9995; // alpha + beta + gamma/2
const MLE_GRID = 6;       // points per axis per refinement level (7^3 = 343 cells/level)
const MLE_LEVELS = 5;     // refinement levels
const MLE_MIN_RETURNS = 12; // below this a per-window MLE is too noisy → fixed split

/**
 * Gaussian negative log-likelihood of a variance-targeting GJR-GARCH(1,1) with
 * the given (alpha, gamma, beta), evaluated on a demeaned return series. omega is
 * pinned so the unconditional variance equals `sampleVar`. The conditional
 * variance starts at the unconditional level and evolves by the sign-gated GJR
 * recursion — the ARCH weight is `alpha` on an up-move and `alpha + gamma` on a
 * down-move, exactly as `GjrGarch11Surface.nextVariance` applies it (the sign of
 * the demeaned return is the sign of the standardized innovation z_t). Returns
 * +Infinity for a parameterization that makes omega non-positive or the variance
 * collapse (so the search rejects it).
 *
 * @param {number[]} rets       demeaned log returns
 * @param {number} sampleVar    sample variance the model is targeted to
 * @param {number} alpha
 * @param {number} gamma
 * @param {number} beta
 * @returns {number}            sum of per-observation NLL contributions
 */
function gjrNegLogLik(rets, sampleVar, alpha, gamma, beta) {
  const omega = sampleVar * (1 - alpha - beta - gamma / 2);
  if (!(omega > 0)) return Infinity;
  let h = sampleVar; // start at the unconditional variance
  let nll = 0;
  for (let t = 0; t < rets.length; t += 1) {
    if (!(h > 0)) return Infinity;
    const r = rets[t];
    const r2 = r * r;
    nll += 0.5 * (Math.log(h) + r2 / h);
    const archWeight = r < 0 ? alpha + gamma : alpha;
    h = omega + archWeight * r2 + beta * h;
  }
  return nll;
}

/**
 * Estimate (alpha, gamma, beta) for one asset by maximizing the variance-targeting
 * Gaussian likelihood of the sign-gated GJR recursion over the demeaned returns,
 * via deterministic nested grid refinement. Falls back to the fixed defaults when
 * the window is too short for a per-window fit to mean anything.
 *
 * @param {number[]} rets       demeaned log returns
 * @param {number} sampleVar
 * @param {object} [opts]
 * @param {number} [opts.alpha]  default split (fallback / seed)
 * @param {number} [opts.gamma]
 * @param {number} [opts.beta]
 * @returns {{ alpha: number, gamma: number, beta: number }}
 */
function estimateGjrGarchParams(rets, sampleVar, opts = {}) {
  const fallbackAlpha = opts.alpha != null ? opts.alpha : DEFAULT_ALPHA;
  const fallbackGamma = opts.gamma != null ? opts.gamma : DEFAULT_GAMMA;
  const fallbackBeta = opts.beta != null ? opts.beta : DEFAULT_BETA;
  if (rets.length < MLE_MIN_RETURNS || !(sampleVar > 0)) {
    return { alpha: fallbackAlpha, gamma: fallbackGamma, beta: fallbackBeta };
  }
  let aLo = MLE_ALPHA_BOUNDS[0];
  let aHi = MLE_ALPHA_BOUNDS[1];
  let gLo = MLE_GAMMA_BOUNDS[0];
  let gHi = MLE_GAMMA_BOUNDS[1];
  let bLo = MLE_BETA_BOUNDS[0];
  let bHi = MLE_BETA_BOUNDS[1];
  let best = { alpha: fallbackAlpha, gamma: fallbackGamma, beta: fallbackBeta, nll: Infinity };
  for (let level = 0; level < MLE_LEVELS; level += 1) {
    for (let i = 0; i <= MLE_GRID; i += 1) {
      const alpha = aLo + ((aHi - aLo) * i) / MLE_GRID;
      for (let k = 0; k <= MLE_GRID; k += 1) {
        const gamma = gLo + ((gHi - gLo) * k) / MLE_GRID;
        for (let j = 0; j <= MLE_GRID; j += 1) {
          const beta = bLo + ((bHi - bLo) * j) / MLE_GRID;
          if (alpha < 0 || gamma < 0 || beta < 0) continue;
          if (alpha + gamma < 0) continue;
          if (alpha + beta + gamma / 2 > MLE_MAX_PERSISTENCE) continue;
          const nll = gjrNegLogLik(rets, sampleVar, alpha, gamma, beta);
          // Strict `<` keeps the tie-break deterministic (first — i.e. lowest
          // alpha, then gamma, then beta — wins), independent of platform.
          if (nll < best.nll) best = { alpha, gamma, beta, nll };
        }
      }
    }
    if (!Number.isFinite(best.nll)) {
      return { alpha: fallbackAlpha, gamma: fallbackGamma, beta: fallbackBeta };
    }
    // Refine one grid cell around the incumbent on each axis.
    const aStep = (aHi - aLo) / MLE_GRID;
    const gStep = (gHi - gLo) / MLE_GRID;
    const bStep = (bHi - bLo) / MLE_GRID;
    aLo = Math.max(MLE_ALPHA_BOUNDS[0], best.alpha - aStep);
    aHi = Math.min(MLE_ALPHA_BOUNDS[1], best.alpha + aStep);
    gLo = Math.max(MLE_GAMMA_BOUNDS[0], best.gamma - gStep);
    gHi = Math.min(MLE_GAMMA_BOUNDS[1], best.gamma + gStep);
    bLo = Math.max(MLE_BETA_BOUNDS[0], best.beta - bStep);
    bHi = Math.min(MLE_BETA_BOUNDS[1], best.beta + bStep);
  }
  return { alpha: best.alpha, gamma: best.gamma, beta: best.beta };
}

/**
 * Fit a GJR-GARCH(1,1) surface to a price history the same way
 * `gjrGarchFromPriceHistory` does — variance targeting pins the unconditional
 * variance to the sample variance — but **estimate (alpha, gamma, beta) per asset
 * from the data** (light variance-targeting MLE) instead of taking a single fixed
 * split for every asset. So an instrument with a strong leverage effect (down-moves
 * stoke far more forward vol than up-moves) and a symmetric one get different
 * asymmetries read from their own realized returns, not one config gamma imposed on
 * both.
 *
 * Deterministic (grid search, no RNG; same frames → same params) and robust: an
 * asset with too few returns for a meaningful per-window fit, or a degenerate
 * constant-price asset, falls back to the fixed default split exactly as
 * `gjrGarchFromPriceHistory` would. `opts.alpha` / `opts.gamma` / `opts.beta` set
 * that fallback.
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.alpha]     fallback symmetric ARCH coefficient (default 0.03)
 * @param {number} [opts.gamma]     fallback leverage coefficient (default 0.09)
 * @param {number} [opts.beta]      fallback GARCH coefficient (default 0.90)
 * @param {number} [opts.floor]     variance floor (default 1e-8)
 * @returns {GjrGarch11Surface}
 */
export function gjrGarchMleFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('gjrGarchMleFromPriceHistory: need at least two price frames');
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
    const s2 = sampleVar > 0 ? sampleVar : (opts.floor != null ? opts.floor : DEFAULT_FLOOR);
    // Estimate on demeaned returns so the fit targets the variance, not the drift,
    // and the down/up sign gate keys off the shock rather than the trend.
    const mean = rets.length ? rets.reduce((acc, x) => acc + x, 0) / rets.length : 0;
    const demeaned = rets.map((x) => x - mean);
    const { alpha, gamma, beta } = estimateGjrGarchParams(demeaned, sampleVar, opts);
    params[a] = {
      omega: s2 * (1 - alpha - beta - gamma / 2),
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
