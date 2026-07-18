import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Egarch11Surface, egarchFromPriceHistory, egarchMleFromPriceHistory } from '../egarch.js';
import { Garch11Surface } from '../garch.js';
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

test('egarchMleFromPriceHistory: deterministic — same frames → identical params', () => {
  const surf = new Egarch11Surface({ A: { omega: -0.4, alpha: 0.15, gamma: -0.12, beta: 0.9 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 11 }), 800);
  const a = egarchMleFromPriceHistory(frames).stats('A');
  const b = egarchMleFromPriceHistory(frames).stats('A');
  assert.deepEqual(a, b, 'identical input yields identical estimated params');
});

test('egarchMleFromPriceHistory: variance targeting preserved — unconditional vol tracks the sample', () => {
  const surf = new Egarch11Surface({ A: { omega: -0.4, alpha: 0.15, gamma: -0.12, beta: 0.9 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 }), 1200);
  const rets = [];
  for (let t = 1; t < frames.length; t += 1) rets.push(Math.log(frames[t].A / frames[t - 1].A));
  const n = rets.length;
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const sampleVar = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const st = egarchMleFromPriceHistory(frames).stats('A');
  // omega is pinned to ln(s^2) * (1 - beta), so the geometric-mean unconditional
  // vol equals sqrt(sample variance) regardless of the fitted (alpha, gamma).
  assert.ok(Math.abs(st.unconditionalVol - Math.sqrt(sampleVar)) < 1e-9, 'unconditional vol == sample vol');
  assert.ok(Math.abs(st.omega / (1 - st.beta) - Math.log(sampleVar)) < 1e-9, 'omega targets ln(sample variance)');
});

test('egarchMleFromPriceHistory: recovers the leverage sign — negative gamma on an asymmetric series', () => {
  // Leverage DGP: a genuine EGARCH process where a down-move (z < 0) stokes far
  // more forward log-variance than an up-move of equal size (gamma = -0.2).
  // Symmetric DGP: plain GARCH(1,1), no sign asymmetry (true leverage = 0),
  // driven through the *same* seed.
  const leverageSurf = new Egarch11Surface({ A: { omega: -0.5, alpha: 0.1, gamma: -0.2, beta: 0.9 } });
  const leverage = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: leverageSurf, seed: 5 }), 2500,
  );
  const symmetricSurf = new Garch11Surface({ A: { omega: 0.00015, alpha: 0.09, beta: 0.85 } });
  const symmetric = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: symmetricSurf, seed: 5 }), 2500,
  );

  const levStats = egarchMleFromPriceHistory(leverage).stats('A');
  const symStats = egarchMleFromPriceHistory(symmetric).stats('A');

  // The leverage gamma — the signed-shock coefficient — is the discriminator this
  // estimator adds over the magnitude-only fit. In EGARCH the leverage sign is
  // gamma < 0, so it recovers a clearly negative gamma from the asymmetric series
  // while fitting a near-zero gamma on the symmetric one. (As with the other MLE
  // fitters, the split between alpha and beta is only weakly identified on a light
  // variance-targeting likelihood; the down/up asymmetry gamma reads is the
  // well-identified signal.)
  assert.ok(levStats.gamma < -0.05, `leverage gamma should recover negative, got ${levStats.gamma}`);
  assert.ok(Math.abs(symStats.gamma) < 0.05, `symmetric gamma should be near zero, got ${symStats.gamma}`);
  assert.ok(
    levStats.gamma < symStats.gamma - 0.05,
    `leverage gamma (${levStats.gamma}) << symmetric (${symStats.gamma})`,
  );
  // The down-move log-variance weight strictly exceeds the up-move weight on the
  // leverage series — the asymmetry the auditor/forecaster read out.
  assert.ok(levStats.downWeight > levStats.upWeight, 'down-move reacts harder than up-move');
});

test('egarchMleFromPriceHistory: can fit a reverse-leverage (gamma > 0) the fixed path cannot', () => {
  // A DGP whose up-moves stoke more forward vol than down-moves — reverse
  // leverage (gamma > 0). The fixed fitter defaults to gamma = -0.08 for every
  // asset; the MLE box straddles zero, so it can read the positive sign out.
  const reverseSurf = new Egarch11Surface({ A: { omega: -0.5, alpha: 0.1, gamma: 0.2, beta: 0.9 } });
  const frames = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: reverseSurf, seed: 7 }), 2500,
  );
  const st = egarchMleFromPriceHistory(frames).stats('A');
  assert.ok(st.gamma > 0.05, `reverse-leverage gamma should recover positive, got ${st.gamma}`);
  assert.ok(st.upWeight > st.downWeight, 'up-move reacts harder than down-move');
});

test('egarchMleFromPriceHistory: short window falls back to the fixed defaults', () => {
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 9 });
  const frames = historyFrom(feed, 6); // 6 returns < 12
  const mle = egarchMleFromPriceHistory(frames).stats('A');
  const fixed = egarchFromPriceHistory(frames).stats('A');
  assert.ok(Math.abs(mle.alpha - fixed.alpha) < 1e-12, 'alpha falls back to default');
  assert.ok(Math.abs(mle.gamma - fixed.gamma) < 1e-12, 'gamma falls back to default');
  assert.ok(Math.abs(mle.beta - fixed.beta) < 1e-12, 'beta falls back to default');
});

test('egarchMleFromPriceHistory: honors a custom fallback for a short window', () => {
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 2 });
  const frames = historyFrom(feed, 5);
  const st = egarchMleFromPriceHistory(frames, { alpha: 0.2, gamma: -0.15, beta: 0.8 }).stats('A');
  assert.ok(Math.abs(st.alpha - 0.2) < 1e-12);
  assert.ok(Math.abs(st.gamma - -0.15) < 1e-12);
  assert.ok(Math.abs(st.beta - 0.8) < 1e-12);
});

test('egarchMleFromPriceHistory: a degenerate constant-price asset falls back cleanly', () => {
  const frames = [];
  for (let t = 0; t < 40; t += 1) frames.push({ A: 100 });
  // Zero sample variance → no fit is meaningful → fixed defaults, and the surface
  // stays constructible (omega pinned to the tiny variance floor).
  const st = egarchMleFromPriceHistory(frames).stats('A');
  const fixed = egarchFromPriceHistory(frames).stats('A');
  assert.ok(Math.abs(st.alpha - fixed.alpha) < 1e-12, 'alpha falls back');
  assert.ok(Math.abs(st.gamma - fixed.gamma) < 1e-12, 'gamma falls back');
  assert.ok(Math.abs(st.persistence) < 1, 'surface stays stationary');
});

test('egarchMleFromPriceHistory: too few frames throws', () => {
  assert.throws(() => egarchMleFromPriceHistory([{ A: 100 }]), /at least two price frames/);
});

test("makeVolSurface: { kind: 'egarch', history, estimate: 'mle' } differs from the fixed fit", () => {
  const surf = new Egarch11Surface({ A: { omega: -0.5, alpha: 0.1, gamma: -0.2, beta: 0.9 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 8 }), 2000);
  const viaFactory = makeVolSurface({ kind: 'egarch', history: frames, estimate: 'mle' }).stats('A');
  const direct = egarchMleFromPriceHistory(frames).stats('A');
  assert.deepEqual(viaFactory, direct, 'factory routing matches the direct EGARCH MLE fit');
  // And the estimate flag actually changed the fit off the fixed -0.08 gamma.
  const fixed = makeVolSurface({ kind: 'egarch', history: frames }).stats('A');
  assert.ok(Math.abs(viaFactory.gamma - fixed.gamma) > 1e-6, 'MLE gamma differs from the fixed default');
});
