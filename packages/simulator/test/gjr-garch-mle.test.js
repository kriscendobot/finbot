import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GjrGarch11Surface, gjrGarchFromPriceHistory, gjrGarchMleFromPriceHistory } from '../gjr-garch.js';
import { Garch11Surface, autoGjrGarchMleFromPriceHistory, conditionalVolFromPriceHistory } from '../garch.js';
import { GBMPriceFeed } from '../price-feed.js';
import { makeVolSurface } from '../world.js';

/**
 * Roll a price feed forward into a per-tick price-frame history the fitters
 * consume (`[{ A: price }, ...]`).
 */
function historyFrom(feed, n) {
  const frames = [{ ...feed.current() }];
  for (let i = 0; i < n; i += 1) frames.push({ ...feed.tick() });
  return frames;
}

test('gjrGarchMleFromPriceHistory: deterministic — same frames → identical params', () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.0002, alpha: 0.03, gamma: 0.12, beta: 0.85 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 11 }), 800);
  const a = gjrGarchMleFromPriceHistory(frames).stats('A');
  const b = gjrGarchMleFromPriceHistory(frames).stats('A');
  assert.deepEqual(a, b, 'identical input yields identical estimated params');
});

test('gjrGarchMleFromPriceHistory: variance targeting preserved — unconditional vol tracks the sample', () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.0002, alpha: 0.03, gamma: 0.12, beta: 0.85 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 }), 1200);
  const rets = [];
  for (let t = 1; t < frames.length; t += 1) rets.push(Math.log(frames[t].A / frames[t - 1].A));
  const n = rets.length;
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const sampleVar = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const st = gjrGarchMleFromPriceHistory(frames).stats('A');
  // omega is pinned to s^2 * (1 - alpha - beta - gamma/2), so the model's
  // unconditional vol equals the sample vol regardless of the fitted split.
  assert.ok(Math.abs(st.unconditionalVol - Math.sqrt(sampleVar)) < 1e-9, 'unconditional vol == sample vol');
});

test('gjrGarchMleFromPriceHistory: recovers the leverage effect — asymmetric gamma >> symmetric gamma', () => {
  // Leverage DGP: a genuine GJR process where down-moves stoke far more forward
  // variance than up-moves (gamma = 0.14). Symmetric DGP: plain GARCH(1,1), no
  // sign asymmetry (true gamma = 0) driven through the *same* seed.
  const leverageSurf = new GjrGarch11Surface({ A: { omega: 0.00015, alpha: 0.02, gamma: 0.14, beta: 0.85 } });
  const leverage = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: leverageSurf, seed: 5 }), 2500,
  );
  const symmetricSurf = new Garch11Surface({ A: { omega: 0.00015, alpha: 0.09, beta: 0.85 } });
  const symmetric = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: symmetricSurf, seed: 5 }), 2500,
  );

  const levStats = gjrGarchMleFromPriceHistory(leverage).stats('A');
  const symStats = gjrGarchMleFromPriceHistory(symmetric).stats('A');

  // The leverage gamma — extra ARCH weight on down-moves — is the discriminator
  // this estimator adds over the symmetric fit, and it recovers a clearly
  // positive gamma from the asymmetric series while fitting a near-zero gamma on
  // the symmetric one. (As with the symmetric MLE, the split between alpha and
  // beta is only weakly identified on a light variance-targeting likelihood; the
  // down/up asymmetry that gamma reads is the well-identified signal.)
  assert.ok(levStats.gamma > 0.05, `leverage gamma should recover positive, got ${levStats.gamma}`);
  assert.ok(symStats.gamma < 0.05, `symmetric gamma should be near zero, got ${symStats.gamma}`);
  assert.ok(
    levStats.gamma > symStats.gamma + 0.05,
    `leverage gamma (${levStats.gamma}) >> symmetric (${symStats.gamma})`,
  );
  // The down-move ARCH weight strictly exceeds the up-move weight on the
  // leverage series — the asymmetry the auditor/forecaster read out.
  assert.ok(levStats.downWeight > levStats.upWeight, 'down-move reacts harder than up-move');
});

test('auto-gjr-garch: selects the asymmetric surface only for a material fitted gamma', () => {
  const leverage = historyFrom(new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new GjrGarch11Surface({ A: { omega: 0.00015, alpha: 0.02, gamma: 0.14, beta: 0.85 } }),
    seed: 5,
  }), 200);
  const symmetric = historyFrom(new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Garch11Surface({ A: { omega: 0.00015, alpha: 0.09, beta: 0.85 } }),
    seed: 5,
  }), 200);

  const lev = autoGjrGarchMleFromPriceHistory(leverage).stats('A');
  const sym = autoGjrGarchMleFromPriceHistory(symmetric).stats('A');
  assert.equal(lev.model, 'gjr-garch', `material gamma ${lev.gamma} selects GJR`);
  assert.equal(sym.model, 'garch', `near-zero gamma ${sym.gamma} keeps GARCH`);

  // The same per-asset choice reaches the current-regime reader used by the
  // analyzer, so its conditional-vol denominator agrees with the forecaster.
  const read = conditionalVolFromPriceHistory(leverage, { kind: 'auto-gjr-garch' });
  assert.equal(read.A.model, 'gjr-garch');
  assert.ok(read.A.gamma >= 0.05);
});

test('auto-gjr-garch: a short window does not mistake the GJR fallback gamma for evidence', () => {
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 9 }), 6);
  const st = autoGjrGarchMleFromPriceHistory(frames).stats('A');
  assert.equal(st.model, 'garch', 'the selector requires enough returns for a measured gamma');
});

test('gjrGarchMleFromPriceHistory: short window falls back to the fixed default split', () => {
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 9 });
  const frames = historyFrom(feed, 6); // 6 returns < 12
  const mle = gjrGarchMleFromPriceHistory(frames).stats('A');
  const fixed = gjrGarchFromPriceHistory(frames).stats('A');
  assert.ok(Math.abs(mle.alpha - fixed.alpha) < 1e-12, 'alpha falls back to default');
  assert.ok(Math.abs(mle.gamma - fixed.gamma) < 1e-12, 'gamma falls back to default');
  assert.ok(Math.abs(mle.beta - fixed.beta) < 1e-12, 'beta falls back to default');
});

test('gjrGarchMleFromPriceHistory: honors a custom fallback split for a short window', () => {
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 2 });
  const frames = historyFrom(feed, 5);
  const st = gjrGarchMleFromPriceHistory(frames, { alpha: 0.04, gamma: 0.06, beta: 0.7 }).stats('A');
  assert.ok(Math.abs(st.alpha - 0.04) < 1e-12);
  assert.ok(Math.abs(st.gamma - 0.06) < 1e-12);
  assert.ok(Math.abs(st.beta - 0.7) < 1e-12);
});

test('gjrGarchMleFromPriceHistory: a degenerate constant-price asset falls back cleanly', () => {
  const frames = [];
  for (let t = 0; t < 40; t += 1) frames.push({ A: 100 });
  // Zero sample variance → no fit is meaningful → fixed default split, and the
  // surface stays constructible (omega pinned to the tiny variance floor).
  const st = gjrGarchMleFromPriceHistory(frames).stats('A');
  const fixed = gjrGarchFromPriceHistory(frames).stats('A');
  assert.ok(Math.abs(st.alpha - fixed.alpha) < 1e-12, 'alpha falls back');
  assert.ok(Math.abs(st.gamma - fixed.gamma) < 1e-12, 'gamma falls back');
  assert.ok(st.persistence < 1, 'surface stays stationary');
});

test('gjrGarchMleFromPriceHistory: too few frames throws', () => {
  assert.throws(() => gjrGarchMleFromPriceHistory([{ A: 100 }]), /at least two price frames/);
});

test("makeVolSurface: { kind: 'gjr-garch', history, estimate: 'mle' } differs from the fixed split", () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.00015, alpha: 0.02, gamma: 0.14, beta: 0.85 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 8 }), 2000);
  const viaFactory = makeVolSurface({ kind: 'gjr-garch', history: frames, estimate: 'mle' }).stats('A');
  const direct = gjrGarchMleFromPriceHistory(frames).stats('A');
  assert.deepEqual(viaFactory, direct, 'factory routing matches the direct GJR MLE fit');
  // And the estimate flag actually changed the fit off the fixed 0.09 gamma.
  const fixed = makeVolSurface({ kind: 'gjr-garch', history: frames }).stats('A');
  assert.ok(Math.abs(viaFactory.gamma - fixed.gamma) > 1e-6, 'MLE gamma differs from the fixed default');
});
