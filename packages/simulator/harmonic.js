/**
 * Seasonal-decomposition + residual-GBM forecaster.
 *
 * The ensemble forecaster (`forecast.js`) forks a price feed into an
 * ensemble and reads the terminal-equity distribution. With a GBM feed it
 * can only represent a random walk, so it mis-covers any oracle whose price
 * carries cyclical / mean-reverting structure (a sinusoid that returns to
 * its trend). `forecast-eval.js` surfaces exactly that: GBM is well
 * calibrated on GBM presets but mis-covers the cyclic and synthesis presets
 * (PIT KS 0.5-1.0, coverage 0.0 or 1.0).
 *
 * This module closes that gap. `fitHarmonicModel` decomposes a training
 * window into:
 *
 *   - a deterministic part: a log-linear trend plus a small set of
 *     harmonics (frequency / amplitude / phase) recovered from the series;
 *   - a stochastic residual: whatever the deterministic part does not
 *     explain, modelled as a GBM random walk in log space.
 *
 * `HarmonicPriceFeed` (in `price-feed.js`) replays that decomposition: each
 * forked child evolves the *same* deterministic seasonal trajectory but an
 * *independent* residual walk, so the ensemble's spread reflects only the
 * residual volatility while its center tracks the cycle. Plugged into the
 * unchanged fork-based `forecast()` shape, it is scored by `evaluateForecast`
 * exactly as the GBM feed is.
 *
 * Frequencies are detected on the *differenced* log series, not the level
 * series: a random walk has a red (1/f^2) periodogram whose low-frequency
 * power would otherwise be mistaken for a cycle, but its first difference is
 * white (flat periodogram), while a cycle's difference is still a sharp peak
 * at the same frequency. Differencing therefore whitens the GBM background
 * so a pure-GBM process selects no harmonics and the model degrades cleanly
 * to a fitted GBM — the non-regression guarantee the eval table needs.
 *
 * Everything is deterministic from the inputs: the fit consumes no RNG, and
 * the feed's RNG is seeded, so two runs produce byte-identical forecasts.
 */

/**
 * @typedef {object} Harmonic
 * @property {number} frequency           cycles per tick
 * @property {number} alpha               cosine coefficient (log space)
 * @property {number} beta                sine coefficient (log space)
 * @property {number} amplitude           sqrt(alpha^2 + beta^2)
 * @property {number} phase               atan2(beta, alpha)
 */

/**
 * @typedef {object} HarmonicModel
 * @property {number} logInitial          fitted log-level at t = 0
 * @property {number} drift               per-tick log-drift (linear slope)
 * @property {Harmonic[]} harmonics       selected harmonic terms
 * @property {number} residualSigma       per-step residual volatility (GBM sigma of the residual walk)
 * @property {number} residualDrift       per-step residual mean (≈ 0 once the trend is removed)
 * @property {number} rSquared            fraction of log-variance explained by the deterministic part
 */

/**
 * Fit a seasonal-decomposition model to a price series.
 *
 * @param {number[]} series                 price series (length + 1 entries)
 * @param {object} [opts]
 * @param {number} [opts.maxHarmonics]       cap on selected harmonics, default 8
 * @param {number} [opts.peakRatio]          peak power must exceed this * median, default 16
 * @param {number} [opts.minPeriod]          shortest detectable period (ticks), default 3
 * @param {number} [opts.maxPeriodFraction]  longest period as a fraction of length, default 1/3
 * @param {number} [opts.oversample]         periodogram oversampling factor, default 4
 * @returns {HarmonicModel}
 */
export function fitHarmonicModel(series, opts = {}) {
  const maxHarmonics = opts.maxHarmonics != null ? opts.maxHarmonics : 8;
  const peakRatio = opts.peakRatio != null ? opts.peakRatio : 16;
  const minPeriod = opts.minPeriod != null ? opts.minPeriod : 3;
  const maxPeriodFraction = opts.maxPeriodFraction != null ? opts.maxPeriodFraction : 1 / 3;
  const oversample = opts.oversample != null ? opts.oversample : 4;

  const n = series.length;
  if (n < 4) {
    // Too short to fit anything but a flat level.
    const logInitial = series.length ? Math.log(series[0]) : 0;
    return { logInitial, drift: 0, harmonics: [], residualSigma: 0, residualDrift: 0, rSquared: 0 };
  }

  // Work in log space: a multiplicative cycle / GBM is additive there.
  const y = series.map((p) => Math.log(p));
  const ts = [];
  for (let t = 0; t < n; t += 1) ts.push(t);

  // Detect candidate frequencies on the *differenced* (whitened) series.
  const diff = [];
  for (let t = 1; t < n; t += 1) diff.push(y[t] - y[t - 1]);
  const frequencies = detectFrequencies(diff, {
    maxHarmonics,
    peakRatio,
    minPeriod,
    maxPeriodFraction,
    oversample,
    length: n,
  });

  // Joint least squares on the *level* series: columns are
  //   [ 1, t/n, cos(2*pi*f_k*t), sin(2*pi*f_k*t) for each detected f_k ].
  // The linear term is scaled by 1/n so every column is O(1) and the
  // normal-equation solve stays well conditioned.
  const columns = [
    ts.map(() => 1),
    ts.map((t) => t / n),
  ];
  for (const f of frequencies) {
    columns.push(ts.map((t) => Math.cos(2 * Math.PI * f * t)));
    columns.push(ts.map((t) => Math.sin(2 * Math.PI * f * t)));
  }
  const coeffs = leastSquares(columns, y);

  const logInitial = coeffs[0];
  const drift = coeffs[1] / n;
  /** @type {Harmonic[]} */
  const harmonics = [];
  for (let k = 0; k < frequencies.length; k += 1) {
    const alpha = coeffs[2 + 2 * k];
    const beta = coeffs[2 + 2 * k + 1];
    harmonics.push({
      frequency: frequencies[k],
      alpha,
      beta,
      amplitude: Math.hypot(alpha, beta),
      phase: Math.atan2(beta, alpha),
    });
  }

  // Residuals of the level fit; their first differences are the residual
  // walk increments. For a pure cycle these are ~0; for a synthesis /
  // GBM process they recover the underlying diffusion sigma.
  const fitted = ts.map((t) => {
    let v = logInitial + drift * t;
    for (const h of harmonics) {
      v += h.alpha * Math.cos(2 * Math.PI * h.frequency * t) + h.beta * Math.sin(2 * Math.PI * h.frequency * t);
    }
    return v;
  });
  const resid = y.map((v, i) => v - fitted[i]);
  const residDiff = [];
  for (let t = 1; t < n; t += 1) residDiff.push(resid[t] - resid[t - 1]);
  const { mean: residualDrift, variance: residVar } = momentsPopulation(residDiff);
  const residualSigma = Math.sqrt(Math.max(0, residVar));

  // R^2 of the deterministic part against the log series.
  const { variance: yVar } = momentsPopulation(y);
  const { variance: rVar } = momentsPopulation(resid);
  const rSquared = yVar > 0 ? Math.max(0, Math.min(1, 1 - rVar / yVar)) : 0;

  return { logInitial, drift, harmonics, residualSigma, residualDrift, rSquared };
}

/**
 * Detect cyclical frequencies via a periodogram peak search.
 *
 * The input is expected to be (approximately) white under the null of "no
 * cycle" — pass the differenced log series, not the level. Peaks are scored
 * by spectral power, refined to sub-bin precision by parabolic
 * interpolation, and kept only when they stand far enough above the median
 * background.
 *
 * @param {number[]} signal
 * @param {object} cfg
 * @returns {number[]}                     selected frequencies (cycles/tick), ascending
 */
export function detectFrequencies(signal, cfg) {
  const { maxHarmonics, peakRatio, minPeriod, maxPeriodFraction, oversample, length } = cfg;
  const m = signal.length;
  if (m < 4) return [];

  const fMax = 1 / minPeriod;
  const fMin = 1 / (maxPeriodFraction * length);
  if (!(fMax > fMin)) return [];

  // Periodogram over an oversampled frequency grid.
  const df = 1 / (oversample * length);
  const freqs = [];
  const power = [];
  for (let f = fMin; f <= fMax + 1e-12; f += df) {
    let sc = 0;
    let ss = 0;
    for (let i = 0; i < m; i += 1) {
      const ang = 2 * Math.PI * f * i;
      sc += signal[i] * Math.cos(ang);
      ss += signal[i] * Math.sin(ang);
    }
    freqs.push(f);
    power.push(sc * sc + ss * ss);
  }
  if (power.length < 3) return [];

  const median = medianOf(power);
  const threshold = peakRatio * (median > 0 ? median : 1e-300);

  // Local maxima above threshold, refined by parabolic interpolation.
  /** @type {Array<{frequency: number, power: number}>} */
  const peaks = [];
  for (let i = 1; i < power.length - 1; i += 1) {
    if (power[i] <= power[i - 1] || power[i] < power[i + 1]) continue;
    if (power[i] < threshold) continue;
    // Parabolic interpolation on (i-1, i, i+1) for the sub-bin peak offset.
    const a = power[i - 1];
    const b = power[i];
    const c = power[i + 1];
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const refined = freqs[i] + Math.max(-0.5, Math.min(0.5, delta)) * df;
    peaks.push({ frequency: refined, power: b });
  }

  peaks.sort((x, y) => y.power - x.power);
  const chosen = [];
  const minSep = df * 1.5;
  for (const p of peaks) {
    if (chosen.length >= maxHarmonics) break;
    if (chosen.some((q) => Math.abs(q - p.frequency) < minSep)) continue;
    chosen.push(p.frequency);
  }
  chosen.sort((x, y) => x - y);
  return chosen;
}

/**
 * Ordinary least squares via the normal equations with Gaussian elimination
 * and partial pivoting. Columns are given as arrays of equal length.
 *
 * @param {number[][]} columns             design-matrix columns
 * @param {number[]} y                     response
 * @returns {number[]}                     one coefficient per column
 */
export function leastSquares(columns, y) {
  const p = columns.length;
  const n = y.length;
  // Normal matrix A^T A (p x p) and A^T y (p).
  const ata = Array.from({ length: p }, () => new Array(p).fill(0));
  const aty = new Array(p).fill(0);
  for (let j = 0; j < p; j += 1) {
    const cj = columns[j];
    let s = 0;
    for (let r = 0; r < n; r += 1) s += cj[r] * y[r];
    aty[j] = s;
    for (let k = j; k < p; k += 1) {
      const ck = columns[k];
      let acc = 0;
      for (let r = 0; r < n; r += 1) acc += cj[r] * ck[r];
      ata[j][k] = acc;
      ata[k][j] = acc;
    }
  }
  return solveLinear(ata, aty);
}

/**
 * Solve M x = b for x by Gaussian elimination with partial pivoting.
 *
 * @param {number[][]} matrix              square, mutated in place
 * @param {number[]} rhs                   mutated in place
 * @returns {number[]}
 */
export function solveLinear(matrix, rhs) {
  const n = rhs.length;
  for (let col = 0; col < n; col += 1) {
    // Partial pivot.
    let pivot = col;
    let best = Math.abs(matrix[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(matrix[r][col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (pivot !== col) {
      const tmp = matrix[pivot]; matrix[pivot] = matrix[col]; matrix[col] = tmp;
      const t2 = rhs[pivot]; rhs[pivot] = rhs[col]; rhs[col] = t2;
    }
    const diag = matrix[col][col];
    if (Math.abs(diag) < 1e-300) continue; // singular column: leave coefficient 0
    for (let r = col + 1; r < n; r += 1) {
      const factor = matrix[r][col] / diag;
      if (factor === 0) continue;
      for (let c = col; c < n; c += 1) matrix[r][c] -= factor * matrix[col][c];
      rhs[r] -= factor * rhs[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let s = rhs[row];
    for (let c = row + 1; c < n; c += 1) s -= matrix[row][c] * x[c];
    const diag = matrix[row][row];
    x[row] = Math.abs(diag) < 1e-300 ? 0 : s / diag;
  }
  return x;
}

/**
 * Population mean and variance of a numeric array.
 *
 * @param {number[]} xs
 * @returns {{mean: number, variance: number}}
 */
function momentsPopulation(xs) {
  const n = xs.length;
  if (n === 0) return { mean: 0, variance: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / n;
  return { mean, variance };
}

/**
 * Median of a numeric array (does not mutate the input).
 *
 * @param {number[]} xs
 * @returns {number}
 */
function medianOf(xs) {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}
