/**
 * EGARCH(1,1) conditional-volatility surface — asymmetry in *log* variance.
 *
 * Symmetric GARCH (see `garch.js`) reacts to the magnitude of the last shock
 * but is blind to its sign; GJR-GARCH (`gjr-garch.js`) adds a sign-gated ARCH
 * term to capture the leverage effect but must clamp its coefficients so the
 * variance recursion can never go negative (`alpha >= 0`, `alpha + gamma >= 0`,
 * `alpha + beta + gamma/2 < 1`). Nelson's **exponential GARCH** (EGARCH, 1991)
 * takes a different route: it evolves the **logarithm** of the variance, so the
 * variance is `exp(...)` and therefore *automatically positive* — the
 * coefficients carry no non-negativity constraint at all. Only the persistence
 * `beta` is bounded (`|beta| < 1`) for stationarity.
 *
 *   ln(sigma^2_{t+1}) = omega
 *                     + beta * ln(sigma^2_t)
 *                     + alpha * (|z_t| - E|z|)
 *                     + gamma * z_t
 *
 * where `z_t = r_t / sigma_t` is the standardized innovation (the same
 * post-correlation unit-gaussian shock the price feed already hands
 * `nextVariance`), and `E|z| = sqrt(2/pi)` is the mean absolute deviation of a
 * standard normal. Two coefficients act on the shock, decoupled:
 *
 *   - **alpha** is the *magnitude* (ARCH) response: a large |shock| in either
 *     direction pushes `alpha * (|z| - E|z|)` above zero, raising forward
 *     log-variance. It is the EGARCH analogue of the symmetric GARCH `alpha`.
 *   - **gamma** is the *sign* (leverage) response: `gamma * z_t` is linear in the
 *     signed shock, so it distinguishes an up-move from a down-move of equal
 *     size. With **gamma < 0** a negative shock (z < 0) *adds* `-gamma * |z| > 0`
 *     to log-variance while a positive shock *subtracts* it — bad news fattens
 *     the near-term distribution more than good news, the leverage effect. This
 *     is the EGARCH sign convention (opposite to GJR's `gamma > 0`), because in
 *     EGARCH gamma multiplies the signed shock rather than a positive indicator.
 *
 * Concretely the per-unit-magnitude log-variance impact of a shock is
 * `alpha - gamma` on a down-move and `alpha + gamma` on an up-move; gamma < 0
 * makes the down-move impact the larger of the two. gamma = 0 collapses onto a
 * symmetric (magnitude-only) log-GARCH.
 *
 * Like every other surface here EGARCH draws **zero** RNG of its own and holds
 * only immutable params; the evolving variance lives per feed instance. It is a
 * drop-in `volSurface` (its `isGarch` is true and it exposes the same
 * `has`/`initialVariance`/`nextVariance`/`stats` interface), so the feed drives
 * it with no code change.
 *
 * Stationarity and the unconditional level. Because `E[alpha*(|z|-E|z|) +
 * gamma*z] = 0` for a symmetric innovation, the log-variance is a stable AR(1)
 * with mean `omega / (1 - beta)` whenever `|beta| < 1`. So the representative
 * (geometric-mean) unconditional volatility is `exp(0.5 * omega / (1 - beta))`,
 * which is what `sigma0` and `stats().unconditionalVol` report.
 */

const DEFAULT_FLOOR = 1e-8;
const DEFAULT_ALPHA = 0.15; // magnitude (ARCH) response
const DEFAULT_GAMMA = -0.08; // leverage: gamma < 0 → down-moves stoke more vol
const DEFAULT_BETA = 0.95; // log-variance persistence

// E|z| for a standard normal — the mean absolute deviation the |z| term is
// centred on, so a *typical* shock contributes zero magnitude response.
const EABS_Z = Math.sqrt(2 / Math.PI);

// Clamp the evolved log-variance so a freak shock can never produce a
// non-finite variance (exp overflow). Well outside any plausible regime: a
// vol of exp(25) is astronomically large but still finite, so the surface
// stays constructible and the feed keeps stepping.
const LOG_VAR_CAP = 50;

/**
 * @typedef {object} EgarchParams
 * @property {number} omega     log-variance intercept (any sign)
 * @property {number} alpha     magnitude (ARCH) response (>= 0)
 * @property {number} gamma     leverage response — < 0 is the leverage sign (any sign)
 * @property {number} beta      log-variance persistence (|beta| < 1)
 * @property {number} [sigma0]  starting volatility; defaults to the unconditional vol
 */

/**
 * @typedef {object} EgarchStats
 * @property {number} omega
 * @property {number} alpha
 * @property {number} gamma
 * @property {number} beta
 * @property {number} persistence         beta (|beta| < 1)
 * @property {number} unconditionalVol    exp(0.5 * omega / (1 - beta))
 * @property {number} sigma0              starting volatility
 * @property {number} downWeight          per-unit-magnitude log-var impact of a down-move (alpha - gamma)
 * @property {number} upWeight            per-unit-magnitude log-var impact of an up-move (alpha + gamma)
 */

export class Egarch11Surface {
  /**
   * @param {Record<string, EgarchParams>} params   EGARCH(1,1) params per asset
   * @param {object} [opts]
   * @param {number} [opts.floor]                    clamp conditional variance to at least this (default 1e-8)
   */
  constructor(params, opts = {}) {
    if (!params || typeof params !== 'object') {
      throw new Error('Egarch11Surface: params must be a { asset: { omega, alpha, gamma, beta } } map');
    }
    /** @type {Record<string, Required<EgarchParams>>} */
    this.params = {};
    for (const [asset, p] of Object.entries(params)) {
      if (!p || typeof p !== 'object') {
        throw new Error(`Egarch11Surface: asset ${asset} needs { omega, alpha, gamma, beta }`);
      }
      const omega = p.omega;
      const alpha = p.alpha;
      const gamma = p.gamma != null ? p.gamma : 0;
      const beta = p.beta;
      if (!Number.isFinite(omega)) throw new Error(`Egarch11Surface: asset ${asset} omega must be finite`);
      // The magnitude response is a genuine ARCH term; a negative alpha would
      // make a big shock *calm* the series, which is not EGARCH. gamma is
      // deliberately unconstrained in sign (that is the whole point of the
      // log-variance form) — the leverage sign is gamma < 0.
      if (!(alpha >= 0)) throw new Error(`Egarch11Surface: asset ${asset} alpha must be >= 0`);
      if (!Number.isFinite(gamma)) throw new Error(`Egarch11Surface: asset ${asset} gamma must be finite`);
      // Only the persistence is bounded — |beta| < 1 keeps the log-variance
      // AR(1) stationary. No non-negativity constraint is needed anywhere else
      // because the variance is exp(log-variance), positive by construction.
      if (!(Math.abs(beta) < 1)) {
        throw new Error(`Egarch11Surface: asset ${asset} is non-stationary (|beta| = ${Math.abs(beta)} must be < 1)`);
      }
      const uncondLogVar = omega / (1 - beta);
      const sigma0 = p.sigma0 != null ? p.sigma0 : Math.exp(0.5 * uncondLogVar);
      if (!(sigma0 >= 0)) throw new Error(`Egarch11Surface: asset ${asset} sigma0 must be >= 0`);
      this.params[asset] = { omega, alpha, gamma, beta, sigma0 };
    }
    this.floor = opts.floor != null ? opts.floor : DEFAULT_FLOOR;
  }

  /**
   * Marks this as a stateful conditional-vol surface so the price feed drives
   * it with the realized shock — same contract as `Garch11Surface`.
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
    if (!p) throw new Error(`Egarch11Surface.initialVariance: no params for asset ${asset}`);
    return Math.max(this.floor, p.sigma0 * p.sigma0);
  }

  /**
   * Advance one asset's conditional variance one step given the variance used
   * this tick and the standardized shock z_t that realized this tick. The
   * log-variance evolves by the EGARCH recursion; the returned variance is its
   * exponential, floored.
   *
   * @param {string} asset
   * @param {number} varNow    sigma^2_t used this tick
   * @param {number} shock     standardized innovation z_t (unit gaussian)
   * @returns {number}         sigma^2_{t+1}, floored
   */
  nextVariance(asset, varNow, shock) {
    const p = this.params[asset];
    if (!p) throw new Error(`Egarch11Surface.nextVariance: no params for asset ${asset}`);
    const logNow = Math.log(Math.max(this.floor, varNow));
    const z = shock;
    let logNext = p.omega + p.beta * logNow + p.alpha * (Math.abs(z) - EABS_Z) + p.gamma * z;
    // Guard against exp overflow from a freak shock — clamp the log-variance
    // to a sane finite band. The lower clamp keeps it above the variance floor.
    if (logNext > LOG_VAR_CAP) logNext = LOG_VAR_CAP;
    const next = Math.exp(logNext);
    return Math.max(this.floor, next);
  }

  /**
   * @param {string} asset
   * @returns {EgarchStats}
   */
  stats(asset) {
    const p = this.params[asset];
    if (!p) throw new Error(`Egarch11Surface.stats: no params for asset ${asset}`);
    return {
      omega: p.omega,
      alpha: p.alpha,
      gamma: p.gamma,
      beta: p.beta,
      persistence: p.beta,
      unconditionalVol: Math.exp(0.5 * (p.omega / (1 - p.beta))),
      sigma0: p.sigma0,
      downWeight: p.alpha - p.gamma,
      upWeight: p.alpha + p.gamma,
    };
  }
}

/**
 * Fit an EGARCH(1,1) surface to a price-feed history by pinning the
 * unconditional *log*-variance to the sample log-variance — the EGARCH analogue
 * of the variance targeting `garchFromPriceHistory` / `gjrGarchFromPriceHistory`
 * use. Given the sample variance `s^2` of per-tick log returns and a chosen
 * (alpha, gamma, beta),
 *
 *   omega = ln(s^2) * (1 - beta)
 *
 * so the long-run mean of `ln(sigma^2)` equals `ln(s^2)` — the geometric-mean
 * variance targets the sample variance. Defaults (alpha = 0.15, gamma = -0.08,
 * beta = 0.95 — persistence 0.95) are typical of daily equity/crypto series: a
 * strong magnitude response, a moderate *negative* gamma carrying the leverage
 * asymmetry, and high persistence. Deterministic, no optimizer; full per-asset
 * MLE of (omega, alpha, gamma, beta) is deferred, exactly as it was for the
 * first GJR cut.
 *
 * Note this fits the unconditional level, not the asymmetry itself — gamma is
 * supplied, not estimated. It reproduces the clustering *and* the sign-asymmetry
 * of the surface without options data or a likelihood search; estimating gamma
 * from the realized down/up response is the natural next refinement (the same
 * one the MLE fitters closed on the symmetric and GJR axes).
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.alpha]     magnitude response (default 0.15)
 * @param {number} [opts.gamma]     leverage response (default -0.08)
 * @param {number} [opts.beta]      log-variance persistence (default 0.95)
 * @param {number} [opts.floor]     variance floor (default 1e-8)
 * @returns {Egarch11Surface}
 */
export function egarchFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('egarchFromPriceHistory: need at least two price frames');
  }
  const alpha = opts.alpha != null ? opts.alpha : DEFAULT_ALPHA;
  const gamma = opts.gamma != null ? opts.gamma : DEFAULT_GAMMA;
  const beta = opts.beta != null ? opts.beta : DEFAULT_BETA;
  if (!(alpha >= 0 && Number.isFinite(gamma) && Math.abs(beta) < 1)) {
    throw new Error(
      `egarchFromPriceHistory: need alpha >= 0, gamma finite, |beta| < 1 ` +
        `(got alpha=${alpha}, gamma=${gamma}, beta=${beta})`,
    );
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, EgarchParams>} */
  const params = {};
  for (const a of assets) {
    const rets = [];
    for (let t = 1; t < priceFrames.length; t += 1) {
      const prev = priceFrames[t - 1][a];
      const cur = priceFrames[t][a];
      if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
    }
    const sampleVar = variance(rets);
    // Guard a degenerate (constant-price) asset: pin a tiny floor so ln(s^2)
    // stays finite and the surface stays constructible.
    const s2 = sampleVar > 0 ? sampleVar : (opts.floor != null ? opts.floor : DEFAULT_FLOOR);
    params[a] = {
      omega: Math.log(s2) * (1 - beta),
      alpha,
      gamma,
      beta,
      sigma0: Math.sqrt(s2),
    };
  }
  return new Egarch11Surface(params, { floor: opts.floor });
}

// --- Variance-targeting maximum-likelihood estimation of (alpha, gamma, beta) --
//
// `egarchFromPriceHistory` pins the unconditional log-variance to the sample
// log-variance but takes the magnitude response *and the leverage gamma* from
// configuration. That models *how much* the series varies but not *how
// asymmetrically its log-variance responds* — a symmetric, magnitude-only
// instrument and a leverage-heavy one (a big drop stokes far more forward vol
// than a big rise) get the same fixed gamma. The estimator below reads the
// asymmetry out of the data: holding the unconditional log-variance pinned at
// ln(sample variance) (variance targeting), it searches (alpha, gamma, beta) to
// maximize the Gaussian likelihood of the EGARCH log-variance recursion. gamma
// emerges from the realized down/up log-variance response rather than a config
// default — the refinement the `egarchFromPriceHistory` doc names as "the
// natural next" one, closed here exactly as the symmetric and GJR MLE cuts
// closed it on their axes.
//
// Like the symmetric and GJR fitters the search is a **deterministic nested grid
// refinement**: a coarse grid over the (alpha, gamma, beta) box, then
// successively finer grids around the best cell — no optimizer library, no RNG,
// byte-identical params for identical input. It is a *light* MLE: variance
// targeting removes omega from the search (omega = ln(s^2) * (1 - beta), which in
// the log-variance form depends on beta alone, unlike GJR where it couples to all
// three) so only the three persistence coefficients are fit, cheaper and more
// stable on the short windows the OODA cycle observes.
//
// The one structural difference from the GJR search: **gamma is NOT bounded
// non-negative here**. In EGARCH gamma multiplies the *signed* standardized
// shock (not a positive down-indicator), so the leverage sign is gamma < 0 and a
// mild reverse-leverage is gamma > 0 — the box must straddle zero for the fit to
// find either. Only the persistence beta is bounded (|beta| < 1), the whole point
// of the log-variance form.

const MLE_ALPHA_BOUNDS = [0.0, 0.6];
const MLE_GAMMA_BOUNDS = [-0.4, 0.4]; // straddles zero: gamma < 0 is the leverage sign
const MLE_BETA_BOUNDS = [0.0, 0.999];
const MLE_GRID = 6;         // points per axis per refinement level (7^3 = 343 cells/level)
const MLE_LEVELS = 5;       // refinement levels
const MLE_MIN_RETURNS = 12; // below this a per-window MLE is too noisy → fixed defaults

/**
 * Gaussian negative log-likelihood of a variance-targeting EGARCH(1,1) with the
 * given (alpha, gamma, beta), evaluated on a demeaned return series. omega is
 * pinned so the unconditional log-variance equals `ln(sampleVar)`. The
 * conditional variance starts at the unconditional level and evolves by the
 * EGARCH log-variance recursion — the standardized shock is `z_t = r_t /
 * sqrt(h_t)` and the log-variance moves by `alpha*(|z_t| - E|z|) + gamma*z_t`,
 * exactly as `Egarch11Surface.nextVariance` applies it. Returns +Infinity for a
 * parameterization whose variance goes non-finite (so the search rejects it).
 *
 * @param {number[]} rets       demeaned log returns
 * @param {number} sampleVar    sample variance the model is targeted to
 * @param {number} alpha
 * @param {number} gamma
 * @param {number} beta
 * @returns {number}            sum of per-observation NLL contributions
 */
function egarchNegLogLik(rets, sampleVar, alpha, gamma, beta) {
  const logUncond = Math.log(sampleVar);
  const omega = logUncond * (1 - beta);
  let logH = logUncond; // start at the unconditional log-variance
  let nll = 0;
  for (let t = 0; t < rets.length; t += 1) {
    const h = Math.exp(logH);
    if (!(h > 0) || !Number.isFinite(h)) return Infinity;
    const r = rets[t];
    nll += 0.5 * (logH + (r * r) / h);
    const z = r / Math.sqrt(h);
    logH = omega + beta * logH + alpha * (Math.abs(z) - EABS_Z) + gamma * z;
    if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
  }
  return nll;
}

/**
 * Estimate (alpha, gamma, beta) for one asset by maximizing the variance-targeting
 * Gaussian likelihood of the EGARCH log-variance recursion over the demeaned
 * returns, via deterministic nested grid refinement. Falls back to the fixed
 * defaults when the window is too short for a per-window fit to mean anything.
 *
 * @param {number[]} rets       demeaned log returns
 * @param {number} sampleVar
 * @param {object} [opts]
 * @param {number} [opts.alpha]  default magnitude response (fallback / seed)
 * @param {number} [opts.gamma]  default leverage response
 * @param {number} [opts.beta]   default persistence
 * @returns {{ alpha: number, gamma: number, beta: number }}
 */
function estimateEgarchParams(rets, sampleVar, opts = {}) {
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
      if (alpha < 0) continue;
      for (let k = 0; k <= MLE_GRID; k += 1) {
        const gamma = gLo + ((gHi - gLo) * k) / MLE_GRID;
        for (let j = 0; j <= MLE_GRID; j += 1) {
          const beta = bLo + ((bHi - bLo) * j) / MLE_GRID;
          if (!(Math.abs(beta) < 1)) continue;
          const nll = egarchNegLogLik(rets, sampleVar, alpha, gamma, beta);
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
 * Fit an EGARCH(1,1) surface to a price history the same way
 * `egarchFromPriceHistory` does — variance targeting pins the unconditional
 * log-variance to ln(sample variance) — but **estimate (alpha, gamma, beta) per
 * asset from the data** (light variance-targeting MLE) instead of taking a single
 * fixed set for every asset. So an instrument with a strong leverage effect
 * (down-moves stoke far more forward vol than up-moves) and a symmetric one get
 * different asymmetries read from their own realized returns, not one config gamma
 * imposed on both — and, unlike the fixed path, the fit can find a *reverse*
 * leverage (gamma > 0) where the data show one.
 *
 * Deterministic (grid search, no RNG; same frames → same params) and robust: an
 * asset with too few returns for a meaningful per-window fit, or a degenerate
 * constant-price asset, falls back to the fixed defaults exactly as
 * `egarchFromPriceHistory` would. `opts.alpha` / `opts.gamma` / `opts.beta` set
 * that fallback.
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.alpha]     fallback magnitude response (default 0.15)
 * @param {number} [opts.gamma]     fallback leverage response (default -0.08)
 * @param {number} [opts.beta]      fallback persistence (default 0.95)
 * @param {number} [opts.floor]     variance floor (default 1e-8)
 * @returns {Egarch11Surface}
 */
export function egarchMleFromPriceHistory(priceFrames, opts = {}) {
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('egarchMleFromPriceHistory: need at least two price frames');
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, EgarchParams>} */
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
    // and the standardized shock keys off the innovation rather than the trend.
    const mean = rets.length ? rets.reduce((acc, x) => acc + x, 0) / rets.length : 0;
    const demeaned = rets.map((x) => x - mean);
    // Pass the raw sample variance (not the floored s2): a degenerate zero-variance
    // asset must trip the estimator's `sampleVar > 0` guard and fall back cleanly.
    const { alpha, gamma, beta } = estimateEgarchParams(demeaned, sampleVar, opts);
    params[a] = {
      omega: Math.log(s2) * (1 - beta),
      alpha,
      gamma,
      beta,
      sigma0: Math.sqrt(s2),
    };
  }
  return new Egarch11Surface(params, { floor: opts.floor });
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
