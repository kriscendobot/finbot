/**
 * Synthetic oracle time-series fixtures — seeded, reproducible generators.
 *
 * These produce "consistent but random" price series: deterministic from a
 * single integer seed (via the same sfc32 / gaussian primitives the price
 * feed uses), so a fixture is byte-for-byte identical across runs but still
 * exercises the forecaster with non-trivial stochastic structure.
 *
 * Three generating processes, each parameterized so its *true* parameters
 * are known and recorded on the returned `meta`. Because the generating
 * process is known, the evaluation harness (`forecast-eval.js`) can score
 * whether the ensemble forecaster recovers the distribution it should.
 *
 *   - cyclicSeries     — a multiplicative sinusoid (configurable frequency,
 *                        amplitude, phase, optional log-drift and noise).
 *   - gbmSeries        — geometric Brownian motion (configurable drift mu
 *                        and volatility sigma; multiplicative, log-normal
 *                        steps), the same step law as GBMPriceFeed.
 *   - synthesisSeries  — superposed cycles of differing period and amplitude
 *                        atop a GBM trend, so volatility (sigma) and
 *                        cyclicality (the per-cycle amplitudes) dial
 *                        independently.
 *
 * Each returns `{ series: number[], meta }`. `series[0]` is the initial
 * price and `series` has `length + 1` entries (the t=0 anchor plus `length`
 * steps), matching the convention the simulator's history uses.
 */

import { sfc32, gaussian } from './price-feed.js';

/**
 * Cyclic (sinusoidal) series.
 *
 *   S_t = initialPrice * exp(drift * t) * (1 + amplitude * sin(2*pi*f*t + phase))
 *         * (1 + noiseSigma * Z_t)          // optional multiplicative noise
 *
 * `frequency` is in cycles per tick (so the period is `1 / frequency`
 * ticks). `amplitude` is a fraction of the trend level (0.1 => +/-10%).
 * `drift` is a per-tick log-drift (0 => flat trend). When `noiseSigma` is 0
 * the series is purely deterministic in t (no RNG draws).
 *
 * @param {object} cfg
 * @param {number} [cfg.initialPrice]   default 100
 * @param {number} [cfg.frequency]      cycles per tick, default 1/64
 * @param {number} [cfg.amplitude]      fractional, default 0.1
 * @param {number} [cfg.phase]          radians, default 0
 * @param {number} [cfg.drift]          per-tick log-drift, default 0
 * @param {number} [cfg.noiseSigma]     multiplicative gaussian noise, default 0
 * @param {number} [cfg.length]         number of steps, default 256
 * @param {number} [cfg.seed]           default 42 (only consumed when noiseSigma>0)
 * @returns {{ series: number[], meta: object }}
 */
export function cyclicSeries(cfg = {}) {
  const initialPrice = cfg.initialPrice != null ? cfg.initialPrice : 100;
  const frequency = cfg.frequency != null ? cfg.frequency : 1 / 64;
  const amplitude = cfg.amplitude != null ? cfg.amplitude : 0.1;
  const phase = cfg.phase != null ? cfg.phase : 0;
  const drift = cfg.drift != null ? cfg.drift : 0;
  const noiseSigma = cfg.noiseSigma != null ? cfg.noiseSigma : 0;
  const length = cfg.length != null ? cfg.length : 256;
  const seed = cfg.seed != null ? cfg.seed : 42;

  const rng = sfc32(seed);
  const series = new Array(length + 1);
  for (let t = 0; t <= length; t += 1) {
    const trend = Math.exp(drift * t);
    const cycle = 1 + amplitude * Math.sin(2 * Math.PI * frequency * t + phase);
    let s = initialPrice * trend * cycle;
    if (noiseSigma > 0) s *= 1 + noiseSigma * gaussian(rng);
    series[t] = s;
  }
  return {
    series,
    meta: {
      kind: 'cyclic',
      initialPrice,
      frequency,
      period: 1 / frequency,
      amplitude,
      phase,
      drift,
      noiseSigma,
      length,
      seed,
    },
  };
}

/**
 * Geometric Brownian motion series (multiplicative log-normal steps).
 *
 *   S_{t+1} = S_t * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z_t)
 *
 * The per-step log-return is therefore normal with mean
 * `(mu - sigma^2/2) * dt` and variance `sigma^2 * dt`; the evaluation tests
 * recover exactly these moments from the realized series.
 *
 * @param {object} cfg
 * @param {number} [cfg.initialPrice]   default 100
 * @param {number} [cfg.mu]             drift, default 0
 * @param {number} [cfg.sigma]          volatility, default 0.02
 * @param {number} [cfg.dt]             time per step, default 1
 * @param {number} [cfg.length]         number of steps, default 256
 * @param {number} [cfg.seed]           default 42
 * @returns {{ series: number[], meta: object }}
 */
export function gbmSeries(cfg = {}) {
  const initialPrice = cfg.initialPrice != null ? cfg.initialPrice : 100;
  const mu = cfg.mu != null ? cfg.mu : 0;
  const sigma = cfg.sigma != null ? cfg.sigma : 0.02;
  const dt = cfg.dt != null ? cfg.dt : 1;
  const length = cfg.length != null ? cfg.length : 256;
  const seed = cfg.seed != null ? cfg.seed : 42;

  const rng = sfc32(seed);
  const series = new Array(length + 1);
  series[0] = initialPrice;
  const driftTerm = (mu - 0.5 * sigma * sigma) * dt;
  const diffusionScale = sigma * Math.sqrt(dt);
  for (let t = 1; t <= length; t += 1) {
    const z = gaussian(rng);
    series[t] = series[t - 1] * Math.exp(driftTerm + diffusionScale * z);
  }
  return {
    series,
    meta: {
      kind: 'gbm',
      initialPrice,
      mu,
      sigma,
      dt,
      length,
      seed,
      // The known per-step log-return moments — what a calibrated forecaster
      // must recover.
      logReturnMean: driftTerm,
      logReturnVariance: sigma * sigma * dt,
    },
  };
}

/**
 * Synthesis series: superposed cycles of differing period and amplitude on
 * top of a GBM trend.
 *
 *   S_t = gbmPath_t * prod_k (1 + a_k * sin(2*pi*f_k*t + phi_k))
 *
 * The GBM path carries the stochastic trend (volatility dialed by `sigma`);
 * the cycle product carries the deterministic cyclical structure (dialed by
 * the per-cycle amplitudes), so the two axes move independently.
 *
 * @param {object} cfg
 * @param {number} [cfg.initialPrice]   default 100
 * @param {object} [cfg.gbm]            { mu, sigma, dt } for the trend (default mu 0, sigma 0.015)
 * @param {Array<{frequency:number, amplitude:number, phase?:number}>} [cfg.cycles]
 *                                      default two cycles of differing period/amplitude
 * @param {number} [cfg.length]         number of steps, default 256
 * @param {number} [cfg.seed]           default 42
 * @returns {{ series: number[], meta: object }}
 */
export function synthesisSeries(cfg = {}) {
  const initialPrice = cfg.initialPrice != null ? cfg.initialPrice : 100;
  const gbmCfg = cfg.gbm || {};
  const cycles = cfg.cycles || [
    { frequency: 1 / 64, amplitude: 0.08, phase: 0 },
    { frequency: 1 / 16, amplitude: 0.03, phase: Math.PI / 3 },
  ];
  const length = cfg.length != null ? cfg.length : 256;
  const seed = cfg.seed != null ? cfg.seed : 42;

  // The GBM trend is generated at unit initial price, then the cycle product
  // and the requested initial price scale it. This keeps the cycle factor a
  // clean multiplicative overlay whose mean over a period is ~1.
  const { series: trend, meta: gbmMeta } = gbmSeries({
    initialPrice: 1,
    mu: gbmCfg.mu != null ? gbmCfg.mu : 0,
    sigma: gbmCfg.sigma != null ? gbmCfg.sigma : 0.015,
    dt: gbmCfg.dt != null ? gbmCfg.dt : 1,
    length,
    seed,
  });

  const series = new Array(length + 1);
  for (let t = 0; t <= length; t += 1) {
    let cycleFactor = 1;
    for (const c of cycles) {
      cycleFactor *= 1 + c.amplitude * Math.sin(2 * Math.PI * c.frequency * t + (c.phase || 0));
    }
    series[t] = initialPrice * trend[t] * cycleFactor;
  }
  return {
    series,
    meta: {
      kind: 'synthesis',
      initialPrice,
      gbm: { mu: gbmMeta.mu, sigma: gbmMeta.sigma, dt: gbmMeta.dt },
      cycles: cycles.map((c) => ({
        frequency: c.frequency,
        period: 1 / c.frequency,
        amplitude: c.amplitude,
        phase: c.phase || 0,
      })),
      length,
      seed,
      logReturnVariance: gbmMeta.logReturnVariance,
    },
  };
}

/**
 * Block-bootstrap a new series from a user-supplied historical (or
 * speculated) price series. Resamples contiguous blocks of the historical
 * log-returns and replays them from `initialPrice`, preserving short-range
 * autocorrelation while generating an independent realization per seed.
 *
 * This is the "driven from historical data — provided by the user, or the
 * user's speculation about upcoming trends" input path: hand it a real
 * series and it yields the ensemble of plausible futures the evaluation and
 * the instruments consume, alongside the synthetic fixtures.
 *
 * @param {object} cfg
 * @param {number[]} cfg.historical       observed price series (>=2 points)
 * @param {number} [cfg.length]           steps to generate, default historical.length-1
 * @param {number} [cfg.blockSize]        bootstrap block length, default 8
 * @param {number} [cfg.initialPrice]     default historical[historical.length-1]
 * @param {number} [cfg.seed]             default 42
 * @returns {{ series: number[], meta: object }}
 */
export function blockBootstrapSeries(cfg = {}) {
  const historical = cfg.historical;
  if (!Array.isArray(historical) || historical.length < 2) {
    throw new Error('blockBootstrapSeries: historical must have >= 2 points');
  }
  const rets = seriesLogReturns(historical);
  if (rets.length === 0) throw new Error('blockBootstrapSeries: no positive log-returns');
  const length = cfg.length != null ? cfg.length : historical.length - 1;
  const blockSize = cfg.blockSize != null ? cfg.blockSize : 8;
  const initialPrice = cfg.initialPrice != null
    ? cfg.initialPrice
    : historical[historical.length - 1];
  const seed = cfg.seed != null ? cfg.seed : 42;

  const rng = sfc32(seed);
  const series = new Array(length + 1);
  series[0] = initialPrice;
  let i = 0;
  while (i < length) {
    // Draw a random block start and copy a contiguous run of returns.
    const start = Math.floor(rng() * rets.length);
    for (let b = 0; b < blockSize && i < length; b += 1) {
      const r = rets[(start + b) % rets.length];
      series[i + 1] = series[i] * Math.exp(r);
      i += 1;
    }
  }
  return {
    series,
    meta: {
      kind: 'block-bootstrap',
      initialPrice,
      length,
      blockSize,
      seed,
      historicalLength: historical.length,
    },
  };
}

/**
 * Per-step log-returns of a price series.
 *
 * @param {number[]} series
 * @returns {number[]}                  length series.length - 1
 */
export function seriesLogReturns(series) {
  const rets = [];
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1];
    const b = series[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  return rets;
}

/**
 * Convert a single-asset price series into ReplayPriceFeed frames.
 *
 * @param {number[]} series
 * @param {string} [asset]              default 'ASSET'
 * @returns {Array<Record<string, number>>}
 */
export function seriesToFrames(series, asset = 'ASSET') {
  return series.map((p) => ({ [asset]: p }));
}
