/**
 * Empirical volatility surface.
 *
 * A volatility surface vends a per-asset volatility to the price feed.
 * Rather than pin one constant sigma per asset (the GBM default), a
 * forecaster can sample sigma from the *empirical distribution* of an
 * asset's realized volatility — so the ensemble explores vol-of-vol,
 * not just price diffusion at a fixed vol. This widens the terminal
 * distribution's tails toward what the historical record actually
 * showed, which is the whole point of an empirical-surface forecast.
 *
 * The surface is built from `{ asset: number[] }` — a window of realized
 * volatility observations per asset (for example, rolling 20-tick
 * realized vols computed off the price-feed history). Sampling draws one
 * observation uniformly using a *seeded* RNG the caller supplies, so the
 * determinism contract holds: same surface + same RNG stream → same
 * sampled vols. The surface never calls Math.random and never holds its
 * own RNG.
 */

/**
 * @typedef {object} VolSurfaceStats
 * @property {number} mean
 * @property {number} min
 * @property {number} max
 * @property {number} count
 */

export class VolatilitySurface {
  /**
   * @param {Record<string, number[]>} samples    realized-vol observations per asset
   * @param {object} [opts]
   * @param {number} [opts.floor]                  clamp sampled vol to at least this (default 0)
   */
  constructor(samples, opts = {}) {
    if (!samples || typeof samples !== 'object') {
      throw new Error('VolatilitySurface: samples must be a { asset: number[] } map');
    }
    /** @type {Record<string, number[]>} */
    this.samples = {};
    for (const [asset, arr] of Object.entries(samples)) {
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error(`VolatilitySurface: asset ${asset} needs a non-empty sample array`);
      }
      this.samples[asset] = arr.slice();
    }
    this.floor = opts.floor != null ? opts.floor : 0;
  }

  /** @returns {boolean} */
  has(asset) { return Object.prototype.hasOwnProperty.call(this.samples, asset); }

  /**
   * Draw one volatility for an asset from its empirical distribution.
   *
   * Consumes exactly one number from the supplied RNG, so callers can
   * reason about draw counts. Returns the asset's mean vol (consuming no
   * RNG draw beyond the one) when the asset is unknown is NOT done —
   * unknown assets throw, because a silent fallback would mask a
   * mis-wired surface.
   *
   * @param {string} asset
   * @param {() => number} rng        uniform [0,1) source (seeded sfc32)
   * @returns {number}
   */
  sample(asset, rng) {
    const arr = this.samples[asset];
    if (!arr) throw new Error(`VolatilitySurface.sample: no samples for asset ${asset}`);
    const u = rng();
    const idx = Math.min(arr.length - 1, Math.floor(u * arr.length));
    return Math.max(this.floor, arr[idx]);
  }

  /**
   * @param {string} asset
   * @returns {VolSurfaceStats}
   */
  stats(asset) {
    const arr = this.samples[asset];
    if (!arr) throw new Error(`VolatilitySurface.stats: no samples for asset ${asset}`);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of arr) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { mean: sum / arr.length, min, max, count: arr.length };
  }
}

/**
 * Derive an empirical volatility surface from a price-feed history by
 * computing rolling realized volatility (stddev of per-tick log returns)
 * over a sliding window, per asset.
 *
 * @param {Array<Record<string, number>>} priceFrames   per-tick { asset: price }
 * @param {object} [opts]
 * @param {number} [opts.window]                          rolling window in ticks (default 20)
 * @param {number} [opts.floor]                           vol floor (default 1e-6)
 * @returns {VolatilitySurface}
 */
export function surfaceFromPriceHistory(priceFrames, opts = {}) {
  const window = opts.window != null ? opts.window : 20;
  if (!Array.isArray(priceFrames) || priceFrames.length < 2) {
    throw new Error('surfaceFromPriceHistory: need at least two price frames');
  }
  const assets = Object.keys(priceFrames[0]);
  /** @type {Record<string, number[]>} */
  const logReturns = {};
  for (const a of assets) logReturns[a] = [];
  for (let t = 1; t < priceFrames.length; t += 1) {
    for (const a of assets) {
      const prev = priceFrames[t - 1][a];
      const cur = priceFrames[t][a];
      if (prev > 0 && cur > 0) logReturns[a].push(Math.log(cur / prev));
    }
  }
  /** @type {Record<string, number[]>} */
  const samples = {};
  for (const a of assets) {
    const rs = logReturns[a];
    const out = [];
    const w = Math.min(window, rs.length);
    for (let end = w; end <= rs.length; end += 1) {
      const slice = rs.slice(end - w, end);
      out.push(stddev(slice));
    }
    if (out.length === 0) out.push(stddev(rs));
    samples[a] = out;
  }
  return new VolatilitySurface(samples, { floor: opts.floor != null ? opts.floor : 1e-6 });
}

/**
 * @param {number[]} xs
 * @returns {number}
 */
function stddev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1);
  return Math.sqrt(variance);
}
