import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  qlike,
  qlikeLosses,
  dieboldMariano,
  varMse,
  walkForwardVolEval,
  rankByLoss,
  renderVolEvalText,
  GARCH_MODELS,
} from '../vol-eval.js';
import { gbmSeries } from '../fixtures.js';
import { PRESETS, generate } from './fixtures/presets.js';
import { Garch11Surface } from '../garch.js';
import { GBMPriceFeed } from '../price-feed.js';

/** Roll a GARCH-driven price feed into a clustered single-asset series. */
function garchSeries({ params, seed, length }) {
  const surf = new Garch11Surface({ A: params });
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed });
  const series = [feed.current().A];
  for (let i = 0; i < length; i += 1) series.push(feed.tick().A);
  return series;
}

test('qlike: minimized at the true variance, and asymmetric', () => {
  const x = 0.04; // realized proxy
  // QLIKE(h, x) = x/h + ln(h); derivative zero at h = x.
  const atTruth = qlike(x, x);
  assert.ok(qlike(x * 0.5, x) > atTruth, 'under-forecasting variance costs more');
  assert.ok(qlike(x * 2, x) > atTruth, 'over-forecasting variance costs more');
  // Asymmetry: halving h is penalized harder than doubling it.
  assert.ok(qlike(x * 0.5, x) - atTruth > qlike(x * 2, x) - atTruth, 'penalty is asymmetric toward under-forecasting');
});

test('varMse: squared error on the variance scale', () => {
  assert.equal(varMse(0.03, 0.05), (0.05 - 0.03) ** 2);
  assert.equal(varMse(0.05, 0.05), 0);
});

test('dieboldMariano: detects a material paired QLIKE-loss advantage and preserves its direction', () => {
  const lossesA = Array.from({ length: 40 }, (_, i) => 1 + (i % 2 ? 0.02 : -0.02));
  const lossesB = lossesA.map((loss, i) => loss + (i % 2 ? 0.15 : 0.25));
  const aBeatsB = dieboldMariano(lossesA, lossesB, { lag: 0 });
  const bBeatsA = dieboldMariano(lossesB, lossesA, { lag: 0 });

  assert.ok(aBeatsB.meanLossDifference < 0, 'A has lower mean loss');
  assert.ok(aBeatsB.statistic < 0, 'negative statistic favors A');
  assert.ok(aBeatsB.pValue < 0.05, 'paired advantage is statistically significant');
  assert.equal(aBeatsB.better, 'a');
  assert.equal(bBeatsA.better, 'b', 'reversing the order reverses the result');
  assert.ok(Math.abs(aBeatsB.statistic + bBeatsA.statistic) < 1e-12, 'the statistic is antisymmetric');
});

test('dieboldMariano: equal losses are not evidence of a winner', () => {
  const result = dieboldMariano([1, 1.1, 0.9, 1.2], [1, 1.1, 0.9, 1.2]);
  assert.equal(result.meanLossDifference, 0);
  assert.equal(result.statistic, 0);
  assert.equal(result.pValue, 1);
  assert.equal(result.significant, false);
  assert.equal(result.better, null);
  assert.throws(() => dieboldMariano([1], [1]), /at least two observations/);
  assert.throws(() => dieboldMariano([1, 2], [1, Infinity]), /losses must be finite/);
});

test('qlikeLosses: returns paired per-observation losses for a DM comparison', () => {
  const losses = qlikeLosses([0.02, 0.04], [0.1, 0.2]);
  assert.ok(Math.abs(losses[0] - qlike(0.02, 0.01)) < 1e-15);
  assert.ok(Math.abs(losses[1] - qlike(0.04, 0.04)) < 1e-15);
  assert.throws(() => qlikeLosses([0.02], [0.1, 0.2]), /paired arrays/);
});

test('walkForwardVolEval: deterministic — same series → identical table', () => {
  const { series } = gbmSeries({ sigma: 0.02, length: 300, seed: 7 });
  const a = walkForwardVolEval(series);
  const b = walkForwardVolEval(series);
  assert.deepEqual(a, b, 'identical input yields identical table');
});

test('walkForwardVolEval: reports every GARCH model plus three naive baselines', () => {
  const { series } = gbmSeries({ sigma: 0.02, length: 300, seed: 8 });
  const table = walkForwardVolEval(series);
  const names = table.rows.map((r) => r.name);
  for (const m of GARCH_MODELS) assert.ok(names.includes(m.name), `has ${m.name}`);
  assert.ok(names.includes('constant-var'), 'has constant baseline');
  assert.ok(names.some((n) => n.startsWith('ewma-')), 'has EWMA baseline');
  assert.ok(names.some((n) => n.startsWith('rolling-')), 'has rolling baseline');
  assert.equal(table.rows.filter((r) => r.family === 'naive').length, 3, 'exactly three naive rows');
});

test('walkForwardVolEval: train/test split honors trainFraction with no lookahead in sizing', () => {
  const { series } = gbmSeries({ sigma: 0.02, length: 200, seed: 9 });
  const table = walkForwardVolEval(series, { trainFraction: 0.7 });
  // 199 returns; split ~ floor(199*0.7)=139 train, 60 test.
  assert.equal(table.trainN + table.testN, series.length - 1, 'train + test == number of returns');
  assert.ok(Math.abs(table.trainN / (table.trainN + table.testN) - 0.7) < 0.05, 'split near trainFraction');
  for (const r of table.rows) if (Number.isFinite(r.n)) assert.equal(r.n, table.testN, `${r.name} scored on the full test window`);
  assert.equal(table.qlikeComparison.n, table.testN, 'DM comparison uses the same held-out suffix');
  assert.equal(table.qlikeComparison.comparator, 'garch-mle', 'DM comparator is the symmetric production baseline');
  assert.ok(
    ['gjr-garch-mle', 'egarch-mle'].includes(table.qlikeComparison.candidate),
    'DM candidate is an asymmetric production branch',
  );
});

test('walkForwardVolEval: DM reports the live selector contest, not the broad-table winner', () => {
  const preset = PRESETS.find(({ name }) => name === 'gbm-bull');
  const { series } = generate(preset, { length: 120 });
  const table = walkForwardVolEval(series, { trainFraction: 0.6 });
  const rawWinner = rankByLoss(table.rows, 'qlike').winner;
  const byName = Object.fromEntries(table.rows.map((row) => [row.name, row]));

  assert.equal(rawWinner, 'ewma-0.94', 'the broad table may honestly favor a naive baseline');
  assert.equal(table.qlikeComparison.comparator, 'garch-mle');
  assert.equal(table.qlikeComparison.candidate, 'egarch-mle');
  assert.ok(
    byName['egarch-mle'].qlike < byName['gjr-garch-mle'].qlike,
    'the report chooses the best asymmetric branch before testing it against GARCH',
  );
});

test('walkForwardVolEval: on a clustered GARCH process, a GARCH model beats the flat constant on QLIKE', () => {
  // A high-persistence, high-reaction process: genuine volatility clustering
  // that a constant variance cannot track.
  const series = garchSeries({ params: { omega: 0.00002, alpha: 0.12, beta: 0.86 }, seed: 5, length: 900 });
  const table = walkForwardVolEval(series, { trainFraction: 0.5 });
  const byName = Object.fromEntries(table.rows.map((r) => [r.name, r]));
  const constQlike = byName['constant-var'].qlike;
  const bestGarch = Math.min(
    ...GARCH_MODELS.map((m) => byName[m.name]?.qlike).filter((q) => Number.isFinite(q)),
  );
  assert.ok(Number.isFinite(bestGarch), 'at least one GARCH model fit');
  assert.ok(bestGarch < constQlike, `best GARCH QLIKE ${bestGarch} < constant ${constQlike}`);
});

test('walkForwardVolEval: on an i.i.d. (constant-vol) GBM, the constant baseline is competitive', () => {
  // No clustering to exploit — GARCH should not meaningfully beat the flat
  // number, so the naive column is doing its honesty job.
  const { series } = gbmSeries({ sigma: 0.02, mu: 0, length: 800, seed: 3 });
  const table = walkForwardVolEval(series, { trainFraction: 0.5 });
  const byName = Object.fromEntries(table.rows.map((r) => [r.name, r]));
  const constQlike = byName['constant-var'].qlike;
  const bestGarch = Math.min(
    ...GARCH_MODELS.map((m) => byName[m.name]?.qlike).filter((q) => Number.isFinite(q)),
  );
  // Constant is within a small margin of the best GARCH (GARCH earns little).
  assert.ok(constQlike - bestGarch < 0.15, `constant close to best GARCH on i.i.d. (const ${constQlike}, garch ${bestGarch})`);
});

test('rankByLoss: orders ascending and names the winner, NaN rows sort last', () => {
  const rows = [
    { name: 'a', qlike: 2, mse: 1 },
    { name: 'b', qlike: 1, mse: 3 },
    { name: 'c', qlike: NaN, mse: NaN },
  ];
  const { winner, ranked } = rankByLoss(rows, 'qlike');
  assert.equal(winner, 'b');
  assert.deepEqual(ranked.map((r) => r.name), ['b', 'a', 'c']);
});

test('renderVolEvalText: includes header, every row, and flags the winner', () => {
  const { series } = gbmSeries({ sigma: 0.02, length: 200, seed: 4 });
  const table = walkForwardVolEval(series);
  const text = renderVolEvalText(table, { title: 'demo' });
  assert.match(text, /demo/);
  assert.match(text, /QLIKE/);
  assert.match(text, /constant-var/);
  assert.match(text, /best QLIKE:/);
  assert.match(text, /DM QLIKE:/);
  const { winner } = rankByLoss(table.rows, 'qlike');
  assert.match(text, new RegExp(`${winner}.*\\*`), 'winner row carries the * flag');
});
