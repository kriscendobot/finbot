/**
 * Walk-forward out-of-sample volatility-forecast evaluation.
 *
 * The GARCH family (`garch.js`, `gjr-garch.js`, `egarch.js`) fits a
 * conditional-variance process to an observed window. `forecast-eval.js`
 * scores the *terminal distribution* the ensemble projects. This module
 * scores the thing GARCH actually claims to do better than a flat number:
 * the **one-step-ahead conditional variance**, evaluated strictly out of
 * sample.
 *
 * The protocol is textbook walk-forward:
 *
 *   1. Split the return series into a training prefix and a test suffix.
 *   2. Fit each model on the training prefix ONLY (no lookahead).
 *   3. Roll the fitted model forward through the test suffix one step at a
 *      time, recording each one-step-ahead variance forecast h_t BEFORE
 *      seeing return r_t, then folding r_t into the model's state.
 *   4. Score {h_t} against the realized-variance proxy r_t^2 with QLIKE
 *      and MSE loss.
 *
 * Because the parameters are frozen at the train/test boundary and the
 * variance recursion only consumes returns as it reaches them, every h_t
 * is a genuine forecast — nothing downstream of t informs it.
 *
 * Naive baselines are the honesty check. A GARCH model that cannot beat a
 * flat sample variance or RiskMetrics EWMA on a series with real
 * clustering is not earning its complexity; on an i.i.d. (constant-vol)
 * series the flat baseline SHOULD win, and the table is supposed to show
 * that. Reporting GARCH losses without a naive column hides both failures.
 *
 * Loss vocabulary (lower is better; both use r^2 as the variance proxy):
 *   - QLIKE (quasi-likelihood): L(h, x) = x/h + ln(h). The loss whose
 *     minimizer is the true conditional variance under a squared-return
 *     proxy (Patton 2011, robust to the proxy being noisy). Penalizes
 *     under-forecasting variance far more than over-forecasting — the
 *     asymmetry a risk auditor wants.
 *   - MSE: L(h, x) = (x - h)^2. Also proxy-robust, but symmetric and
 *     dominated by the largest r^2 outliers.
 *
 * Simulation only; deterministic given its inputs.
 */

import { seriesLogReturns } from './fixtures.js';
import * as garchMod from './garch.js';
import * as gjrMod from './gjr-garch.js';
import * as egarchMod from './egarch.js';
// The Diebold-Mariano test lives in the leaf selection module so the
// auto-garch-family selector can gate on significance without importing this
// evaluation module (which would form an import cycle through garch.js).
import { dieboldMariano } from './vol-selection.js';

export { dieboldMariano };

const VAR_FLOOR = 1e-12;

/**
 * QLIKE loss for one forecast/proxy pair: x/h + ln(h). Floors h so a
 * degenerate zero forecast cannot produce -Infinity.
 *
 * @param {number} h    variance forecast (> 0)
 * @param {number} x    realized-variance proxy (>= 0)
 * @returns {number}
 */
export function qlike(h, x) {
  const hf = Math.max(VAR_FLOOR, h);
  return x / hf + Math.log(hf);
}

/**
 * Squared-error loss on the variance scale: (x - h)^2.
 *
 * @param {number} h
 * @param {number} x
 * @returns {number}
 */
export function varMse(h, x) {
  return (x - h) * (x - h);
}

/**
 * Mean of a numeric array (0 for empty).
 *
 * @param {number[]} xs
 * @returns {number}
 */
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Per-observation QLIKE losses for a paired forecast comparison.
 *
 * @param {number[]} forecasts
 * @param {number[]} residuals
 * @returns {number[]}
 */
export function qlikeLosses(forecasts, residuals) {
  if (!Array.isArray(forecasts) || !Array.isArray(residuals) || forecasts.length !== residuals.length) {
    throw new Error('qlikeLosses: forecasts and residuals must be paired arrays');
  }
  return forecasts.map((forecast, index) => qlike(forecast, residuals[index] * residuals[index]));
}

/**
 * Score a stream of one-step-ahead variance forecasts against the realized
 * squared-return proxy. `forecasts[i]` is the forecast made for `rets[i]`
 * (i.e. formed before r_i was observed); `residuals[i] = r_i - trainMean`
 * is the demeaned realized return whose square is the proxy.
 *
 * @param {number[]} forecasts
 * @param {number[]} residuals
 * @returns {{ qlike: number, mse: number, n: number }}
 */
function scoreForecasts(forecasts, residuals) {
  const ql = qlikeLosses(forecasts, residuals);
  const se = [];
  for (let i = 0; i < forecasts.length; i += 1) {
    se.push(varMse(forecasts[i], residuals[i] * residuals[i]));
  }
  return { qlike: mean(ql), mse: mean(se), n: forecasts.length };
}

/**
 * Walk a fitted GARCH-family surface forward through the test residuals,
 * emitting the one-step-ahead variance forecast for each. The surface is
 * seeded from its own `initialVariance` (its train-window conditional
 * variance) and advanced by the *realized* standardized shock at each test
 * step — the same recursion `conditionalVolFromPriceHistory` uses, but
 * exposing every intermediate forecast rather than only the terminal vol.
 *
 * @param {object} surface     a GARCH-family surface (isGarch)
 * @param {string} asset
 * @param {number[]} residuals demeaned test returns, in order
 * @returns {number[]}         h_t for each residual (length === residuals.length)
 */
function garchForwardForecasts(surface, asset, residuals) {
  let h = surface.initialVariance(asset);
  const out = [];
  for (const r of residuals) {
    out.push(h); // forecast for this step, formed before seeing r
    const sd = Math.sqrt(h);
    const shock = sd > 0 ? r / sd : 0;
    h = surface.nextVariance(asset, h, shock);
  }
  return out;
}

/**
 * RiskMetrics EWMA baseline: h_{t+1} = lambda*h_t + (1-lambda)*r_t^2.
 * Seeded from the train-window variance, then rolled through the test
 * residuals one-step-ahead.
 *
 * @param {number} seedVar     initial variance (train sample variance)
 * @param {number[]} residuals
 * @param {number} lambda      decay (default 0.94, the RiskMetrics daily value)
 * @returns {number[]}
 */
function ewmaForecasts(seedVar, residuals, lambda = 0.94) {
  let h = seedVar;
  const out = [];
  for (const r of residuals) {
    out.push(h);
    h = lambda * h + (1 - lambda) * r * r;
  }
  return out;
}

/**
 * Rolling-window realized-variance baseline: h_t is the mean of the last
 * `window` squared residuals available strictly before t. The train
 * residuals prime the window so the first test forecast already sees a
 * full window (still no lookahead — only past returns feed it).
 *
 * @param {number[]} trainResiduals
 * @param {number[]} testResiduals
 * @param {number} window
 * @param {number} seedVar     fallback before the window fills
 * @returns {number[]}
 */
function rollingWindowForecasts(trainResiduals, testResiduals, window, seedVar) {
  // Prime with up to `window` most-recent train squared residuals.
  const buf = trainResiduals.slice(-window).map((r) => r * r);
  const out = [];
  for (const r of testResiduals) {
    const h = buf.length ? mean(buf) : seedVar;
    out.push(h);
    buf.push(r * r);
    if (buf.length > window) buf.shift();
  }
  return out;
}

/**
 * Sample variance (population, /N) of a demeaned residual array.
 *
 * @param {number[]} residuals
 * @returns {number}
 */
function residualVariance(residuals) {
  if (!residuals.length) return VAR_FLOOR;
  return Math.max(VAR_FLOOR, mean(residuals.map((r) => r * r)));
}

/**
 * The GARCH-family models the walk-forward table evaluates, each named by
 * the `conditionalVolFromPriceHistory` opts that build it. Kept here (not
 * inline) so `bin/finbot-eval` and the tests agree on the roster.
 *
 * @type {Array<{ name: string, opts: object }>}
 */
export const GARCH_MODELS = [
  { name: 'garch-mle', opts: { estimate: 'mle' } },
  { name: 'gjr-garch-mle', opts: { kind: 'gjr-garch', estimate: 'mle' } },
  { name: 'egarch-mle', opts: { kind: 'egarch', estimate: 'mle' } },
  { name: 'auto-egarch', opts: { kind: 'auto-egarch', estimate: 'mle' } },
  { name: 'auto-garch-family', opts: { kind: 'auto-garch-family', estimate: 'mle' } },
];

// These are the three independent candidates in the production
// auto-garch-family decision. auto-egarch is itself a two-way selector, so it
// belongs in the table but not in this evidence comparison.
const AUTO_GARCH_FAMILY_BASELINE = 'garch-mle';
const AUTO_GARCH_FAMILY_ASYMMETRIC = ['gjr-garch-mle', 'egarch-mle'];

/**
 * Walk-forward OOS volatility evaluation for one single-asset price series.
 *
 * Splits the series' log returns at `trainFraction`, fits every GARCH model
 * and primes every naive baseline on the training returns, then scores each
 * on the held-out test returns with QLIKE and MSE.
 *
 * @param {number[]} series               single-asset price series
 * @param {object} [opts]
 * @param {number} [opts.trainFraction]   split point (default 0.6)
 * @param {number} [opts.ewmaLambda]      EWMA decay (default 0.94)
 * @param {number} [opts.rollingWindow]   rolling-var window (default 32)
 * @param {string} [opts.asset]           asset key for the frame form (default 'ASSET')
 * @param {number|null} [opts.significanceAlpha]  when set (0<α<1), engage the Diebold-Mariano QLIKE significance gate on the auto-* family rows and report the DM contest at this α; null (default) leaves the whole table byte-identical to the ungated behavior
 * @param {object} [opts.dieboldMariano]  options for the asymmetric-vs-GARCH QLIKE test (overrides the α derived from significanceAlpha)
 * @returns {{
 *   trainN: number, testN: number,
 *   rows: Array<{ name: string, qlike: number, mse: number, n: number, family: string }>,
 *   qlikeComparison: ({ candidate: string, comparator: string } & ReturnType<typeof dieboldMariano>)|null
 * }}
 */
export function walkForwardVolEval(series, opts = {}) {
  const trainFraction = opts.trainFraction != null ? opts.trainFraction : 0.6;
  const ewmaLambda = opts.ewmaLambda != null ? opts.ewmaLambda : 0.94;
  const rollingWindow = opts.rollingWindow != null ? opts.rollingWindow : 32;
  const asset = opts.asset || 'ASSET';
  // Optional Diebold-Mariano significance gate for the auto-* family selectors
  // (see designs/ensemble-forecasting.md § optional significance gate). Null
  // (default) leaves every selection — and the whole table — byte-identical to
  // the historic ungated behavior; when set it engages the gate on the
  // auto-egarch / auto-garch-family rows and the DM report so the maintainer
  // can evaluate the gate against the fixtures before deciding whether it
  // should become the live default.
  const significanceAlpha = opts.significanceAlpha != null ? opts.significanceAlpha : null;
  if (significanceAlpha != null && !(significanceAlpha > 0 && significanceAlpha < 1)) {
    throw new Error('walkForwardVolEval: significanceAlpha must be between 0 and 1');
  }

  if (!Array.isArray(series) || series.length < 8) {
    throw new Error('walkForwardVolEval: need at least 8 price points');
  }
  const rets = seriesLogReturns(series);
  if (rets.length < 6) throw new Error('walkForwardVolEval: too few returns to split');

  const splitAt = Math.max(2, Math.min(rets.length - 2, Math.floor(rets.length * trainFraction)));
  const trainRets = rets.slice(0, splitAt);
  const testRets = rets.slice(splitAt);

  // Demean by the TRAIN mean only — the OOS filter may not peek at test drift.
  const trainMean = mean(trainRets);
  const trainResiduals = trainRets.map((r) => r - trainMean);
  const testResiduals = testRets.map((r) => r - trainMean);
  const trainVar = residualVariance(trainResiduals);

  // Reconstruct the training price frames the GARCH fitters consume. The
  // fitters only read log ratios, so an initial-price=100 frame series that
  // reproduces `trainRets` is a faithful training input.
  const trainFrames = [{ [asset]: 100 }];
  for (const r of trainRets) {
    const prev = trainFrames[trainFrames.length - 1][asset];
    trainFrames.push({ [asset]: prev * Math.exp(r) });
  }

  const rows = [];
  const qlikeLossesByName = new Map();

  for (const model of GARCH_MODELS) {
    // The significance gate is an auto-selector concept; merge it only into the
    // auto-* kinds so the fixed baselines (garch/gjr/egarch) stay untouched.
    const isAuto = typeof model.opts.kind === 'string' && model.opts.kind.startsWith('auto-');
    const modelOpts = significanceAlpha != null && isAuto
      ? { ...model.opts, significanceAlpha }
      : model.opts;
    let forecasts;
    try {
      forecasts = fitAndForward(trainFrames, asset, testResiduals, modelOpts);
    } catch (err) {
      // A non-stationary fit on a short/degenerate train window is a real
      // outcome; record it as a skipped row rather than aborting the table.
      rows.push({ name: model.name, qlike: NaN, mse: NaN, n: 0, family: 'garch', error: String(err.message || err) });
      continue;
    }
    rows.push({ ...scoreForecasts(forecasts, testResiduals), name: model.name, family: 'garch' });
    qlikeLossesByName.set(model.name, qlikeLosses(forecasts, testResiduals));
  }

  // --- Naive baselines. ---
  const constForecasts = testResiduals.map(() => trainVar);
  rows.push({ ...scoreForecasts(constForecasts, testResiduals), name: 'constant-var', family: 'naive' });
  qlikeLossesByName.set('constant-var', qlikeLosses(constForecasts, testResiduals));

  const ewma = ewmaForecasts(trainVar, testResiduals, ewmaLambda);
  rows.push({ ...scoreForecasts(ewma, testResiduals), name: `ewma-${ewmaLambda}`, family: 'naive' });
  qlikeLossesByName.set(`ewma-${ewmaLambda}`, qlikeLosses(ewma, testResiduals));

  const rolling = rollingWindowForecasts(trainResiduals, testResiduals, rollingWindow, trainVar);
  rows.push({ ...scoreForecasts(rolling, testResiduals), name: `rolling-${rollingWindow}`, family: 'naive' });
  qlikeLossesByName.set(`rolling-${rollingWindow}`, qlikeLosses(rolling, testResiduals));

  // The live auto-garch-family selector asks one focused question: does the
  // better asymmetric branch earn its extra parameter against symmetric
  // GARCH? The report answers that same question. In particular, a naive row
  // winning the broad table must not turn the DM line into a different contest.
  const byName = new Map(rows.map((row) => [row.name, row]));
  const baseline = byName.get(AUTO_GARCH_FAMILY_BASELINE);
  const asymmetric = AUTO_GARCH_FAMILY_ASYMMETRIC.map((name) => byName.get(name));
  const hasCompleteSelectorEvidence = baseline
    && Number.isFinite(baseline.qlike)
    && qlikeLossesByName.has(baseline.name)
    && asymmetric.every((row) => row && Number.isFinite(row.qlike) && qlikeLossesByName.has(row.name));
  const candidate = hasCompleteSelectorEvidence
    ? asymmetric.slice().sort((a, b) => a.qlike - b.qlike)[0]
    : null;
  // Report the DM contest at the gate's α when one is requested (and no
  // explicit DM options override it), so the reported significance verdict
  // matches the level the selector gate is running at.
  const dmOpts = opts.dieboldMariano
    || (significanceAlpha != null ? { alpha: significanceAlpha } : undefined);
  const qlikeComparison = candidate
    ? {
        candidate: candidate.name,
        comparator: baseline.name,
        ...dieboldMariano(
          qlikeLossesByName.get(candidate.name),
          qlikeLossesByName.get(baseline.name),
          dmOpts,
        ),
      }
    : null;

  return { trainN: trainRets.length, testN: testRets.length, rows, qlikeComparison };
}

/**
 * Fit one GARCH-family surface on training frames and roll it forward
 * through the test residuals. Split out from `walkForwardVolEval` so the
 * fitting path is a single, testable unit.
 *
 * @param {Array<Record<string, number>>} trainFrames
 * @param {string} asset
 * @param {number[]} testResiduals
 * @param {object} opts        conditionalVolFromPriceHistory kind/estimate opts
 * @returns {number[]}
 */
export function fitAndForward(trainFrames, asset, testResiduals, opts) {
  const surface = surfaceFor(trainFrames, opts);
  return garchForwardForecasts(surface, asset, testResiduals);
}

/**
 * Build the GARCH-family surface for the given opts, reusing the exact
 * dispatch `conditionalVolFromPriceHistory` uses so the walk-forward filter
 * and the production regime read never diverge.
 *
 * @param {Array<Record<string, number>>} frames
 * @param {object} opts
 * @returns {object}
 */
function surfaceFor(frames, opts) {
  // Mirror the builder selection `conditionalVolFromPriceHistory` makes, so
  // the walk-forward filter and the production regime read never diverge —
  // but keep the surface object instead of collapsing it to a terminal read.
  const mle = opts.estimate === 'mle';
  if (opts.kind === 'auto-gjr-garch') return garchMod.autoGjrGarchMleFromPriceHistory(frames, opts);
  if (opts.kind === 'auto-egarch') return garchMod.autoEgarchMleFromPriceHistory(frames, opts);
  if (opts.kind === 'gjr-garch') return (mle ? gjrMod.gjrGarchMleFromPriceHistory : gjrMod.gjrGarchFromPriceHistory)(frames, opts);
  if (opts.kind === 'egarch') return (mle ? egarchMod.egarchMleFromPriceHistory : egarchMod.egarchFromPriceHistory)(frames, opts);
  return (mle ? garchMod.garchMleFromPriceHistory : garchMod.garchFromPriceHistory)(frames, opts);
}

/**
 * Rank a walk-forward table's rows by a loss and pick the winner. Rows with
 * a non-finite loss (a failed fit) sort last.
 *
 * @param {Array<{ name: string, qlike: number, mse: number }>} rows
 * @param {'qlike'|'mse'} [metric]
 * @returns {{ winner: string, ranked: Array<{ name: string, value: number }> }}
 */
export function rankByLoss(rows, metric = 'qlike') {
  const ranked = rows
    .map((r) => ({ name: r.name, value: r[metric] }))
    .sort((a, b) => {
      const av = Number.isFinite(a.value) ? a.value : Infinity;
      const bv = Number.isFinite(b.value) ? b.value : Infinity;
      return av - bv;
    });
  return { winner: ranked.length ? ranked[0].name : null, ranked };
}

/**
 * Render a single walk-forward table as fixed-width text.
 *
 * @param {ReturnType<typeof walkForwardVolEval>} table
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @returns {string}
 */
export function renderVolEvalText(table, opts = {}) {
  const lines = [];
  if (opts.title) lines.push(opts.title);
  lines.push(`train=${table.trainN}  test=${table.testN}  (one-step-ahead, OOS)`);
  const { winner } = rankByLoss(table.rows, 'qlike');
  lines.push('  model            family  QLIKE        MSE          n');
  for (const r of table.rows) {
    const ql = Number.isFinite(r.qlike) ? r.qlike.toFixed(4) : r.error ? 'ERR' : 'NaN';
    const ms = Number.isFinite(r.mse) ? r.mse.toExponential(3) : '-';
    const flag = r.name === winner ? ' *' : '';
    lines.push(
      `  ${r.name.padEnd(15)} ${String(r.family).padEnd(6)} ${String(ql).padStart(10)}  ${String(ms).padStart(11)}  ${String(r.n).padStart(4)}${flag}`,
    );
  }
  lines.push(`  best QLIKE: ${winner}`);
  if (table.qlikeComparison) {
    const comparison = table.qlikeComparison;
    const result = comparison.better === 'a'
      ? `${comparison.candidate} significantly better`
      : 'no significant difference';
    lines.push(
      `  DM QLIKE: ${comparison.candidate} vs ${comparison.comparator}; Δ=${comparison.meanLossDifference.toFixed(4)}; DM=${comparison.statistic.toFixed(3)}; p=${comparison.pValue.toFixed(4)}; ${result} (α=${comparison.alpha})`,
    );
  }
  return lines.join('\n');
}
