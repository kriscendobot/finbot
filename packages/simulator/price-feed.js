/**
 * Deterministic simulated price feed.
 *
 * Two impls behind one interface:
 *
 *   - GBMPriceFeed: geometric Brownian motion with seeded RNG.
 *   - ReplayPriceFeed: replay a fixture array (parsed from CSV or
 *     supplied inline). Wraps when exhausted unless `wrap: false`.
 *
 * Both expose:
 *
 *   - `tick()`              -> Record<asset, price>, advances internal state
 *   - `current()`           -> Record<asset, price>, no advance
 *   - `t`                   -> current integer tick index
 *   - `clone({ seed })`     -> deep copy, optionally reseeded
 *
 * The RNG is sfc32 (Chris Doty-Humphrey) — small, fast, no external
 * deps, passes PractRand to 32 TB. We never call Math.random.
 */

import { choleskyFactorFor, applyCholesky } from './correlation.js';

/**
 * sfc32 PRNG. Returns a function that emits uniform [0, 1) floats.
 *
 * Seeded from four uint32s. We derive those four uint32s from a single
 * user-facing 32-bit seed via splitmix32, so the user can pass a small
 * integer.
 *
 * @param {number} seed                32-bit integer
 * @returns {() => number}
 */
export function sfc32(seed) {
  // splitmix32 to expand seed into four uint32s.
  const sm = splitmix32(seed);
  let a = sm() >>> 0;
  let b = sm() >>> 0;
  let c = sm() >>> 0;
  let d = sm() >>> 0;
  return function next() {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * splitmix32: stable seed expansion for sfc32's four state words.
 *
 * @param {number} seed
 * @returns {() => number}
 */
export function splitmix32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x9e3779b9) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * Box-Muller transform: convert two uniform [0,1) samples into one
 * standard-normal sample.
 *
 * @param {() => number} rng
 * @returns {number}
 */
export function gaussian(rng) {
  // Use the form that avoids log(0).
  let u1 = 0;
  while (u1 === 0) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * GBM price feed.
 *
 * S_{t+dt} = S_t * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)
 *
 * Multi-asset. By default each asset walks independently (one sigma per
 * asset). Two optional enrichments:
 *
 *   - Correlation. Pass `cfg.correlations` (a pair spec or full matrix)
 *     and the per-tick standard-normal shock vector is run through the
 *     Cholesky factor of the correlation matrix, so the assets move
 *     together with the requested correlation. The draw count per tick
 *     is unchanged (one gaussian per asset), so the independent walk
 *     stays byte-for-byte identical when no correlation is given.
 *   - Volatility surface. Pass `cfg.volSurface` (a VolatilitySurface)
 *     and each tick samples sigma per asset from the empirical surface
 *     using a *separate* seeded RNG stream (so the main price-shock
 *     stream is undisturbed). Falls back to the fixed `cfg.volatilities`
 *     for any asset the surface does not cover.
 */
export class GBMPriceFeed {
  /**
   * @param {object} cfg
   * @param {Record<string, number>} cfg.initialPrices
   * @param {Record<string, number>} [cfg.drifts]             mu per asset (default 0)
   * @param {Record<string, number>} [cfg.volatilities]       sigma per asset (default 0.02)
   * @param {number} [cfg.dt]                                 default 1 (one tick = one unit time)
   * @param {number} [cfg.seed]                               default 42
   * @param {number[][] | Record<string, any>} [cfg.correlations]   correlation spec for correlated walks
   * @param {import('./vol-surface.js').VolatilitySurface} [cfg.volSurface]   empirical vol surface to sample sigma from
   */
  constructor(cfg) {
    this.initialPrices = { ...cfg.initialPrices };
    this.prices = { ...cfg.initialPrices };
    this.drifts = cfg.drifts || {};
    this.volatilities = cfg.volatilities || {};
    this.defaultVol = 0.02;
    this.dt = cfg.dt != null ? cfg.dt : 1;
    this.seed = cfg.seed != null ? cfg.seed : 42;
    this.rng = sfc32(this.seed);
    this.t = 0;
    // Fixed asset order anchors the correlation matrix and the shock
    // vector. Object key order is insertion order, stable across clones.
    this.assetOrder = Object.keys(this.initialPrices);
    this.correlations = cfg.correlations || null;
    this.choleskyL = choleskyFactorFor(this.assetOrder, this.correlations);
    this.volSurface = cfg.volSurface || null;
    // A separate RNG stream for volatility-surface sampling keeps the
    // price-shock stream's draw schedule independent of whether the
    // surface is in play.
    this.volRng = sfc32((this.seed ^ 0x9e3779b9) >>> 0);
  }

  /**
   * Advance one tick.
   *
   * @returns {Record<string, number>}
   */
  tick() {
    // Draw one standard-normal shock per asset, in fixed asset order.
    const z = new Array(this.assetOrder.length);
    for (let i = 0; i < this.assetOrder.length; i += 1) z[i] = gaussian(this.rng);
    // Apply correlation if present (y = L · z); otherwise shocks are iid.
    const shocks = this.choleskyL ? applyCholesky(this.choleskyL, z) : z;

    const next = {};
    for (let i = 0; i < this.assetOrder.length; i += 1) {
      const asset = this.assetOrder[i];
      const prev = this.prices[asset];
      const mu = this.drifts[asset] || 0;
      const sigma = this.sigmaFor(asset);
      const drift = (mu - 0.5 * sigma * sigma) * this.dt;
      const diffusion = sigma * Math.sqrt(this.dt) * shocks[i];
      next[asset] = prev * Math.exp(drift + diffusion);
    }
    this.prices = next;
    this.t += 1;
    return { ...this.prices };
  }

  /**
   * Resolve this tick's volatility for an asset: an empirical-surface
   * draw when the surface covers the asset, else the fixed config vol.
   *
   * @param {string} asset
   * @returns {number}
   */
  sigmaFor(asset) {
    if (this.volSurface && this.volSurface.has(asset)) {
      return this.volSurface.sample(asset, this.volRng);
    }
    return this.volatilities[asset] != null ? this.volatilities[asset] : this.defaultVol;
  }

  /** @returns {Record<string, number>} */
  current() { return { ...this.prices }; }

  /**
   * Clone, optionally reseeded.
   *
   * @param {object} [opts]
   * @param {number} [opts.seed]
   * @returns {GBMPriceFeed}
   */
  clone(opts = {}) {
    const copy = new GBMPriceFeed({
      initialPrices: this.initialPrices,
      drifts: this.drifts,
      volatilities: this.volatilities,
      dt: this.dt,
      seed: opts.seed != null ? opts.seed : this.seed,
      correlations: this.correlations,
      volSurface: this.volSurface,
    });
    // Preserve current state (current prices + tick counter). The
    // rng is fresh from the (possibly new) seed; subsequent ticks
    // either continue the original sequence (same seed) or diverge
    // (new seed). For the same-seed case, burn the RNG forward to
    // the parent's consumption point so the next tick draws the
    // parent's next sample.
    copy.prices = { ...this.prices };
    copy.t = this.t;
    if (opts.seed == null) {
      const draws = this.t * this.assetOrder.length * 2;
      for (let i = 0; i < draws; i += 1) copy.rng();
      // The vol-surface stream draws once per *covered* asset per tick;
      // resync it the same way so a same-seed clone continues the
      // surface sampling sequence in lockstep with the price shocks.
      if (this.volSurface) {
        const coveredCount = this.assetOrder.filter((a) => this.volSurface.has(a)).length;
        const volDraws = this.t * coveredCount;
        for (let i = 0; i < volDraws; i += 1) copy.volRng();
      }
    }
    return copy;
  }
}

/**
 * Harmonic (seasonal-decomposition + residual-GBM) price feed.
 *
 * Each asset's price is a deterministic seasonal trajectory times an
 * independent stochastic residual walk:
 *
 *   shapeLog(t) = drift * t + sum_k [alpha_k cos(2*pi*f_k*t) + beta_k sin(2*pi*f_k*t)]
 *   relLog(t)   = shapeLog(t) - shapeLog(0)            // anchored so price(0) = initialPrice
 *   W_{t}       = W_{t-1} + residualSigma*sqrt(dt)*Z   // GBM residual in log space
 *   price_t     = initialPrice * exp(relLog(t) + W_t)
 *
 * The seasonal part is identical across forks (it is deterministic in t);
 * only the residual walk W diverges per seed. So when `forecast()` forks the
 * feed into an ensemble, the spread reflects the residual volatility and the
 * center tracks the cycle. The per-asset model is produced by
 * `fitHarmonicModel` (`harmonic.js`).
 *
 * Draw schedule matches GBMPriceFeed: one standard-normal per asset per
 * tick, in a fixed asset order, so a same-seed clone can resync by burning
 * the RNG forward.
 */
export class HarmonicPriceFeed {
  /**
   * @param {object} cfg
   * @param {Record<string, number>} cfg.initialPrices
   * @param {Record<string, {drift: number, harmonics: Array<{frequency: number, alpha: number, beta: number}>, residualSigma: number, residualDrift?: number}>} cfg.models
   * @param {number} [cfg.dt]                                 default 1
   * @param {number} [cfg.seed]                               default 42
   */
  constructor(cfg) {
    this.initialPrices = { ...cfg.initialPrices };
    this.models = cfg.models || {};
    this.dt = cfg.dt != null ? cfg.dt : 1;
    this.seed = cfg.seed != null ? cfg.seed : 42;
    this.rng = sfc32(this.seed);
    this.t = 0;
    this.assetOrder = Object.keys(this.initialPrices);
    // Residual walk accumulator (log space), one per asset, starts at 0.
    this.residualLog = {};
    for (const a of this.assetOrder) this.residualLog[a] = 0;
    this.prices = { ...this.initialPrices };
  }

  /**
   * Deterministic anchored seasonal log-offset relative to t = 0.
   *
   * @param {string} asset
   * @param {number} t
   * @returns {number}
   */
  shapeLogRel(asset, t) {
    const model = this.models[asset];
    if (!model) return 0;
    const drift = model.drift || 0;
    let v = drift * t;
    let v0 = 0;
    const harmonics = model.harmonics || [];
    for (const h of harmonics) {
      const w = 2 * Math.PI * h.frequency;
      v += h.alpha * Math.cos(w * t) + h.beta * Math.sin(w * t);
      v0 += h.alpha; // cos(0) = 1, sin(0) = 0
    }
    return v - v0;
  }

  /**
   * Advance one tick.
   *
   * @returns {Record<string, number>}
   */
  tick() {
    this.t += 1;
    const next = {};
    for (let i = 0; i < this.assetOrder.length; i += 1) {
      const asset = this.assetOrder[i];
      // One gaussian per asset per tick, fixed order (matches GBM schedule).
      const z = gaussian(this.rng);
      const model = this.models[asset];
      const sigma = model ? (model.residualSigma || 0) : 0;
      const mu = model ? (model.residualDrift || 0) : 0;
      this.residualLog[asset] += mu + sigma * Math.sqrt(this.dt) * z;
      const rel = this.shapeLogRel(asset, this.t);
      next[asset] = this.initialPrices[asset] * Math.exp(rel + this.residualLog[asset]);
    }
    this.prices = next;
    return { ...this.prices };
  }

  /** @returns {Record<string, number>} */
  current() { return { ...this.prices }; }

  /**
   * Clone, optionally reseeded. A same-seed clone continues the parent's
   * residual walk (RNG burned forward to the parent's draw count); a
   * reseeded clone forks an independent residual path from the current state.
   *
   * @param {object} [opts]
   * @param {number} [opts.seed]
   * @returns {HarmonicPriceFeed}
   */
  clone(opts = {}) {
    const copy = new HarmonicPriceFeed({
      initialPrices: this.initialPrices,
      models: this.models,
      dt: this.dt,
      seed: opts.seed != null ? opts.seed : this.seed,
    });
    copy.prices = { ...this.prices };
    copy.residualLog = { ...this.residualLog };
    copy.t = this.t;
    if (opts.seed == null) {
      const draws = this.t * this.assetOrder.length;
      for (let i = 0; i < draws; i += 1) copy.rng();
    }
    return copy;
  }
}

/**
 * Replay price feed: fixed-length time series, wraps by default when
 * exhausted.
 *
 * Frames is `Array<Record<asset, price>>`.
 */
export class ReplayPriceFeed {
  /**
   * @param {object} cfg
   * @param {Array<Record<string, number>>} cfg.frames
   * @param {boolean} [cfg.wrap]                 default true
   */
  constructor(cfg) {
    if (!Array.isArray(cfg.frames) || cfg.frames.length === 0) {
      throw new Error('ReplayPriceFeed: frames must be a non-empty array');
    }
    this.frames = cfg.frames.map((f) => ({ ...f }));
    this.wrap = cfg.wrap !== false;
    this.t = 0;
    this.prices = { ...this.frames[0] };
  }

  tick() {
    this.t += 1;
    let idx = this.t;
    if (idx >= this.frames.length) {
      if (!this.wrap) {
        // hold last frame
        return { ...this.prices };
      }
      idx = idx % this.frames.length;
    }
    this.prices = { ...this.frames[idx] };
    return { ...this.prices };
  }

  current() { return { ...this.prices }; }

  clone() {
    const copy = new ReplayPriceFeed({ frames: this.frames, wrap: this.wrap });
    copy.t = this.t;
    copy.prices = { ...this.prices };
    return copy;
  }
}

/**
 * Parse a CSV file body into a `frames` array suitable for
 * ReplayPriceFeed.
 *
 * Expected shape:
 *
 *   t,assetA,assetB,...
 *   0,1.00,2000.00
 *   1,1.01,2010.50
 *   ...
 *
 * The `t` column is optional; if absent, the row index is used.
 *
 * @param {string} csv
 * @returns {Array<Record<string, number>>}
 */
export function parseCsvFrames(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('parseCsvFrames: need header + at least one row');
  const header = lines[0].split(',').map((s) => s.trim());
  const tIdx = header.indexOf('t');
  const frames = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split(',').map((s) => s.trim());
    const frame = {};
    for (let j = 0; j < header.length; j += 1) {
      if (j === tIdx) continue;
      const v = Number(row[j]);
      if (Number.isNaN(v)) throw new Error(`parseCsvFrames: NaN at line ${i + 1} col ${j + 1}`);
      frame[header[j]] = v;
    }
    frames.push(frame);
  }
  return frames;
}
