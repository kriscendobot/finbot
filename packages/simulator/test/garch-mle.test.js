import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Garch11Surface, garchFromPriceHistory, garchMleFromPriceHistory } from '../garch.js';
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

test('garchMleFromPriceHistory: deterministic — same frames → identical params', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0004, alpha: 0.15, beta: 0.8 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 11 }), 800);
  const a = garchMleFromPriceHistory(frames).stats('A');
  const b = garchMleFromPriceHistory(frames).stats('A');
  assert.deepEqual(a, b, 'identical input yields identical estimated params');
});

test('garchMleFromPriceHistory: variance targeting preserved — unconditional vol tracks the sample', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0004, alpha: 0.15, beta: 0.8 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 }), 1200);
  // Sample vol of the log returns the fitter targets.
  const rets = [];
  for (let t = 1; t < frames.length; t += 1) rets.push(Math.log(frames[t].A / frames[t - 1].A));
  const n = rets.length;
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const sampleVar = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const st = garchMleFromPriceHistory(frames).stats('A');
  assert.ok(Math.abs(st.unconditionalVol - Math.sqrt(sampleVar)) < 1e-9, 'unconditional vol == sample vol');
});

test('garchMleFromPriceHistory: recovers the ARCH reaction — clustered alpha >> iid alpha', () => {
  // Clustered: a genuinely persistent GARCH(1,1) data-generating process
  // (alpha=0.12, beta=0.85). Iid: constant-sigma GBM (true alpha=0), no surface.
  const clusteredSurf = new Garch11Surface({ A: { omega: 0.0002, alpha: 0.12, beta: 0.85 } });
  const clustered = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: clusteredSurf, seed: 5 }), 2000,
  );
  const iid = historyFrom(
    new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 5 }), 2000,
  );

  const clStats = garchMleFromPriceHistory(clustered).stats('A');
  const iidStats = garchMleFromPriceHistory(iid).stats('A');

  // The ARCH coefficient alpha — how hard variance reacts to a shock — is the
  // well-identified discriminator and the estimator recovers it closely: a
  // clustered series fits an alpha near its true 0.12, iid noise fits alpha ~0.
  // (Beta, the memory term, is only weakly identified on near-iid data because
  // the variance-targeting likelihood is flat in persistence there — an expected
  // limitation of a *light* variance-targeting MLE; alpha carries the signal.)
  assert.ok(clStats.alpha > 0.06, `clustered alpha should recover near 0.12, got ${clStats.alpha}`);
  assert.ok(iidStats.alpha < 0.05, `iid alpha should be near zero, got ${iidStats.alpha}`);
  assert.ok(clStats.alpha > iidStats.alpha + 0.05, `clustered alpha (${clStats.alpha}) >> iid (${iidStats.alpha})`);
  // The persistence read the pipeline cites is still high for the clustered process.
  assert.ok(clStats.persistence > 0.5, `clustered persistence should be high, got ${clStats.persistence}`);
});

test('garchMleFromPriceHistory: short window falls back to the fixed default split', () => {
  // Fewer than MLE_MIN_RETURNS returns → a per-window fit is meaningless, so the
  // estimator uses the fixed default split exactly as garchFromPriceHistory does.
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 9 });
  const frames = historyFrom(feed, 6); // 6 returns < 12
  const mle = garchMleFromPriceHistory(frames).stats('A');
  const fixed = garchFromPriceHistory(frames).stats('A');
  assert.ok(Math.abs(mle.alpha - fixed.alpha) < 1e-12, 'alpha falls back to default');
  assert.ok(Math.abs(mle.beta - fixed.beta) < 1e-12, 'beta falls back to default');
});

test('garchMleFromPriceHistory: honors a custom fallback split for a short window', () => {
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 2 });
  const frames = historyFrom(feed, 5);
  const st = garchMleFromPriceHistory(frames, { alpha: 0.05, beta: 0.7 }).stats('A');
  assert.ok(Math.abs(st.alpha - 0.05) < 1e-12);
  assert.ok(Math.abs(st.beta - 0.7) < 1e-12);
});

test('garchMleFromPriceHistory: too few frames throws', () => {
  assert.throws(() => garchMleFromPriceHistory([{ A: 100 }]), /at least two price frames/);
});

test("makeVolSurface: { kind: 'garch', history, estimate: 'mle' } routes to the MLE fitter", () => {
  const surf = new Garch11Surface({ A: { omega: 0.0002, alpha: 0.12, beta: 0.85 } });
  const frames = historyFrom(new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 8 }), 1500);
  const viaFactory = makeVolSurface({ kind: 'garch', history: frames, estimate: 'mle' }).stats('A');
  const direct = garchMleFromPriceHistory(frames).stats('A');
  assert.deepEqual(viaFactory, direct, 'factory routing matches the direct MLE fit');
  // And it differs from the fixed-split fit on a clustered window (proof the
  // estimate flag actually changed the fit).
  const fixed = makeVolSurface({ kind: 'garch', history: frames }).stats('A');
  assert.ok(Math.abs(viaFactory.persistence - fixed.persistence) > 1e-6, 'MLE fit differs from fixed split');
});

test("makeVolSurface: gjr-garch + estimate 'mle' throws (deferred)", () => {
  const frames = [{ A: 100 }, { A: 101 }, { A: 100.5 }];
  assert.throws(
    () => makeVolSurface({ kind: 'gjr-garch', history: frames, estimate: 'mle' }),
    /only supported for kind 'garch'/,
  );
});
