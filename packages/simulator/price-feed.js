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
 * Multi-asset: one sigma per asset, optional correlation (currently
 * independent walks; future cut can add a Cholesky-factored covariance).
 */
export class GBMPriceFeed {
  /**
   * @param {object} cfg
   * @param {Record<string, number>} cfg.initialPrices
   * @param {Record<string, number>} [cfg.drifts]             mu per asset (default 0)
   * @param {Record<string, number>} [cfg.volatilities]       sigma per asset (default 0.02)
   * @param {number} [cfg.dt]                                 default 1 (one tick = one unit time)
   * @param {number} [cfg.seed]                               default 42
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
  }

  /**
   * Advance one tick.
   *
   * @returns {Record<string, number>}
   */
  tick() {
    const next = {};
    for (const [asset, prev] of Object.entries(this.prices)) {
      const mu = this.drifts[asset] || 0;
      const sigma = this.volatilities[asset] != null ? this.volatilities[asset] : this.defaultVol;
      const z = gaussian(this.rng);
      const drift = (mu - 0.5 * sigma * sigma) * this.dt;
      const diffusion = sigma * Math.sqrt(this.dt) * z;
      next[asset] = prev * Math.exp(drift + diffusion);
    }
    this.prices = next;
    this.t += 1;
    return { ...this.prices };
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
    });
    // If not reseeded, preserve current state precisely.
    if (opts.seed == null) {
      copy.prices = { ...this.prices };
      copy.t = this.t;
      // Re-run RNG forward this.t calls' worth of consumption. Cheaper
      // path: recreate sfc32 with the same seed and burn this.t * 2
      // gaussian draws' worth of uniforms (gaussian consumes 2 uniforms
      // per call, one per asset). This guarantees a continuing
      // sequence rather than restarting.
      const draws = this.t * Object.keys(this.initialPrices).length * 2;
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
