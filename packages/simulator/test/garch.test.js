import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Garch11Surface,
  garchFromPriceHistory,
  autoEgarchMleFromPriceHistory,
  conditionalVolFromPriceHistory,
} from '../garch.js';
import { GBMPriceFeed } from '../price-feed.js';
import { Egarch11Surface } from '../egarch.js';

test('Garch11Surface: stats reports persistence and unconditional vol', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0002, alpha: 0.1, beta: 0.85 } });
  const s = surf.stats('A');
  assert.ok(Math.abs(s.persistence - 0.95) < 1e-12, 'persistence = alpha + beta');
  // unconditional variance = omega / (1 - persistence) = 0.0002 / 0.05 = 0.004
  assert.ok(Math.abs(s.unconditionalVol - Math.sqrt(0.004)) < 1e-12, 'unconditional vol');
  // sigma0 defaults to the unconditional vol
  assert.ok(Math.abs(s.sigma0 - Math.sqrt(0.004)) < 1e-12, 'sigma0 defaults to unconditional');
});

test('Garch11Surface: initialVariance is sigma0^2', () => {
  const surf = new Garch11Surface({ A: { omega: 0.001, alpha: 0.1, beta: 0.8, sigma0: 0.05 } });
  assert.ok(Math.abs(surf.initialVariance('A') - 0.0025) < 1e-15);
});

test('Garch11Surface: nextVariance follows the GARCH(1,1) recursion', () => {
  const omega = 0.0002;
  const alpha = 0.1;
  const beta = 0.85;
  const surf = new Garch11Surface({ A: { omega, alpha, beta } });
  const varNow = 0.004;
  const z = 2.0; // a large shock
  const expected = omega + (alpha * z * z + beta) * varNow;
  assert.ok(Math.abs(surf.nextVariance('A', varNow, z) - expected) < 1e-15);
  // A larger shock lifts next variance more than a small one — clustering.
  assert.ok(surf.nextVariance('A', varNow, 3.0) > surf.nextVariance('A', varNow, 0.1));
});

test('Garch11Surface: non-stationary / malformed params throw', () => {
  assert.throws(() => new Garch11Surface(null), /params must be/);
  assert.throws(() => new Garch11Surface({ A: { omega: -1, alpha: 0.1, beta: 0.8 } }), /omega must be > 0/);
  assert.throws(() => new Garch11Surface({ A: { omega: 0.001, alpha: 0.5, beta: 0.6 } }), /non-stationary/);
  assert.equal(new Garch11Surface({ A: { omega: 0.001, alpha: 0.1, beta: 0.8 } }).has('B'), false);
});

test('GBMPriceFeed: a GARCH surface is deterministic given a seed', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0004, alpha: 0.15, beta: 0.8 } });
  const mk = () => new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 7 });
  const a = mk();
  const b = mk();
  for (let i = 0; i < 200; i += 1) {
    assert.ok(Math.abs(a.tick().A - b.tick().A) < 1e-12, `tick ${i} identical`);
  }
});

test('GBMPriceFeed: GARCH conditional variance clusters (ACF of squared returns > iid)', () => {
  const acf1SquaredReturns = (feed, n) => {
    const rets = [];
    let prev = feed.current().A;
    for (let i = 0; i < n; i += 1) {
      const p = feed.tick().A;
      rets.push(Math.log(p / prev));
      prev = p;
    }
    const sq = rets.map((r) => r * r);
    const mean = sq.reduce((s, x) => s + x, 0) / sq.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < sq.length; i += 1) {
      den += (sq[i] - mean) * (sq[i] - mean);
      if (i > 0) num += (sq[i] - mean) * (sq[i - 1] - mean);
    }
    return num / den;
  };
  const garch = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Garch11Surface({ A: { omega: 0.0001, alpha: 0.2, beta: 0.78 } }),
    seed: 11,
  });
  const flat = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.05 }, seed: 11 });
  const garchAcf = acf1SquaredReturns(garch, 3000);
  const flatAcf = acf1SquaredReturns(flat, 3000);
  assert.ok(garchAcf > 0.05, `GARCH squared-return ACF(1) is clearly positive (got ${garchAcf})`);
  assert.ok(garchAcf > flatAcf + 0.03, `GARCH clusters more than constant-vol GBM (${garchAcf} vs ${flatAcf})`);
});

test('GBMPriceFeed: a reseeded fork starts a fresh GARCH variance path', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0004, alpha: 0.2, beta: 0.7 } });
  const parent = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 });
  for (let i = 0; i < 50; i += 1) parent.tick();
  const child = parent.clone({ seed: 999 });
  // Fresh path -> variance reset to the surface's initial variance.
  assert.ok(Math.abs(child.garchVar.A - surf.initialVariance('A')) < 1e-15);
  // Two forks with the same new seed evolve identically.
  const twin = parent.clone({ seed: 999 });
  for (let i = 0; i < 100; i += 1) {
    assert.ok(Math.abs(child.tick().A - twin.tick().A) < 1e-12);
  }
});

test('GBMPriceFeed: a same-seed clone carries the evolved GARCH variance forward', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0004, alpha: 0.2, beta: 0.7 } });
  const parent = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 });
  for (let i = 0; i < 40; i += 1) parent.tick();
  const cont = parent.clone(); // no reseed -> continuation
  assert.ok(Math.abs(cont.garchVar.A - parent.garchVar.A) < 1e-15, 'variance carried, not reset');
  // The continuation reproduces the parent's next ticks exactly.
  const parentNext = [];
  for (let i = 0; i < 20; i += 1) parentNext.push(parent.tick().A);
  for (let i = 0; i < 20; i += 1) {
    assert.ok(Math.abs(cont.tick().A - parentNext[i]) < 1e-12, `continuation tick ${i} matches`);
  }
});

test('GBMPriceFeed: assets not covered by the GARCH surface use fixed vol', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0004, alpha: 0.2, beta: 0.7 } });
  const feed = new GBMPriceFeed({
    initialPrices: { A: 100, B: 50 },
    volatilities: { B: 0.03 },
    volSurface: surf,
    seed: 5,
  });
  assert.ok(feed.isGarch);
  assert.equal(feed.garchVar.B, undefined, 'B has no GARCH state');
  assert.ok(Math.abs(feed.sigmaFor('B') - 0.03) < 1e-15, 'B uses its fixed vol');
  assert.ok(Math.abs(feed.sigmaFor('A') - Math.sqrt(surf.initialVariance('A'))) < 1e-15, 'A uses GARCH sigma');
});

test('garchFromPriceHistory: variance targeting pins the unconditional variance to the sample', () => {
  // Build a price history off a plain GBM feed with a known vol.
  const src = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.04 }, seed: 21 });
  const frames = [src.current()];
  for (let i = 0; i < 500; i += 1) frames.push(src.tick());
  const surf = garchFromPriceHistory(frames, { alpha: 0.1, beta: 0.85 });
  const s = surf.stats('A');
  assert.ok(Math.abs(s.persistence - 0.95) < 1e-12, 'persistence from config');
  // Unconditional vol should land near the 0.04 the history was generated with.
  assert.ok(Math.abs(s.unconditionalVol - 0.04) < 0.01, `unconditional vol ~ 0.04 (got ${s.unconditionalVol})`);
  // And omega = s^2 * (1 - alpha - beta) exactly reproduces the target variance.
  assert.ok(Math.abs(s.omega / (1 - s.persistence) - s.unconditionalVol ** 2) < 1e-18);
});

test('garchFromPriceHistory: rejects a non-stationary alpha/beta and too-short history', () => {
  const frames = [{ A: 100 }, { A: 101 }, { A: 99 }];
  assert.throws(() => garchFromPriceHistory(frames, { alpha: 0.6, beta: 0.5 }), /alpha \+ beta < 1/);
  assert.throws(() => garchFromPriceHistory([{ A: 100 }]), /at least two/);
});

// ---------- conditionalVolFromPriceHistory (the regime read) ----------

test('conditionalVolFromPriceHistory: a recent burst lifts conditional vol above unconditional', () => {
  // A calm run, then a cluster of large shocks at the end. A persistent GARCH
  // regime should carry an ELEVATED conditional vol into the next tick.
  const calm = [];
  let p = 100;
  for (let i = 0; i < 40; i += 1) { p *= i % 2 === 0 ? 1.001 : 0.999; calm.push({ A: p }); }
  const burst = [1.06, 0.94, 1.07, 0.93, 1.05].map((m) => { p *= m; return { A: p }; });
  const frames = [...calm, ...burst];
  const read = conditionalVolFromPriceHistory(frames, { alpha: 0.15, beta: 0.8 });
  assert.ok(read.A, 'asset A has a regime read');
  assert.ok(read.A.conditionalVol > read.A.unconditionalVol,
    `recent burst → conditional (${read.A.conditionalVol}) > unconditional (${read.A.unconditionalVol})`);
  assert.ok(Math.abs(read.A.persistence - 0.95) < 1e-12, 'persistence from the fixed split');
});

test('conditionalVolFromPriceHistory: calm after a storm pulls conditional vol below unconditional', () => {
  // A cluster of shocks early, then a long calm tail. The conditional vol
  // should have decayed BELOW the (shock-inflated) unconditional level.
  let p = 100;
  const storm = [1.08, 0.92, 1.09, 0.91, 1.07].map((m) => { p *= m; return { A: p }; });
  const calm = [];
  for (let i = 0; i < 60; i += 1) { p *= i % 2 === 0 ? 1.0005 : 0.9995; calm.push({ A: p }); }
  const frames = [{ A: 100 }, ...storm, ...calm];
  const read = conditionalVolFromPriceHistory(frames, { alpha: 0.15, beta: 0.8 });
  assert.ok(read.A.conditionalVol < read.A.unconditionalVol,
    `calm tail → conditional (${read.A.conditionalVol}) < unconditional (${read.A.unconditionalVol})`);
});

test('conditionalVolFromPriceHistory: deterministic and MLE-routed', () => {
  const src = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.03 }, seed: 5 });
  const frames = [src.current()];
  for (let i = 0; i < 60; i += 1) frames.push(src.tick());
  const a = conditionalVolFromPriceHistory(frames, { estimate: 'mle' });
  const b = conditionalVolFromPriceHistory(frames, { estimate: 'mle' });
  assert.deepEqual(a, b, 'byte-identical for identical input (no RNG)');
  assert.ok(a.A.conditionalVol > 0 && a.A.unconditionalVol > 0);
});

test('conditionalVolFromPriceHistory: too-short history throws', () => {
  assert.throws(() => conditionalVolFromPriceHistory([{ A: 100 }]), /at least two/);
});

// ---------- conditionalVolFromPriceHistory: the asymmetric (GJR) read ----------

// Build a calm run of 40 alternating small moves, then a terminal burst whose
// per-tick multipliers are `endMult`. Signing the terminal burst down vs up
// (with the same magnitudes) is what separates the leverage read from a
// magnitude-only read.
function windowEndingIn(endMult) {
  let p = 100;
  const frames = [{ A: p }];
  for (let i = 0; i < 40; i += 1) { p *= i % 2 === 0 ? 1.002 : 0.998; frames.push({ A: p }); }
  for (const m of endMult) { p *= m; frames.push({ A: p }); }
  return frames;
}

test('conditionalVolFromPriceHistory: a GJR read runs hotter than symmetric after a drawdown', () => {
  // Same down-ending window, same (alpha, beta). The GJR read applies the extra
  // `gamma` ARCH weight on the terminal DOWN shocks, so its conditional vol must
  // sit above the sign-blind symmetric read.
  const frames = windowEndingIn([0.95, 0.94, 0.96, 0.93]);
  const sym = conditionalVolFromPriceHistory(frames, { alpha: 0.05, beta: 0.9 });
  const gjr = conditionalVolFromPriceHistory(frames, { kind: 'gjr-garch', alpha: 0.05, gamma: 0.08, beta: 0.9 });
  assert.ok(gjr.A.conditionalVol > sym.A.conditionalVol,
    `GJR (${gjr.A.conditionalVol}) > symmetric (${sym.A.conditionalVol}) after a drawdown`);
  assert.ok(gjr.A.gamma != null && gjr.A.gamma > 0, 'a GJR read carries a positive gamma');
  assert.ok(sym.A.gamma == null, 'a symmetric read carries no gamma');
});

test('conditionalVolFromPriceHistory: GJR is sign-driven — a drawdown reads hotter than its mirror rally', () => {
  // Identical magnitudes, opposite terminal sign, identical params. A pure
  // magnitude model would read the two the same; the leverage model reads the
  // drawdown strictly hotter.
  const opts = { kind: 'gjr-garch', alpha: 0.05, gamma: 0.1, beta: 0.85 };
  const down = conditionalVolFromPriceHistory(windowEndingIn([0.93, 0.92, 0.94, 0.91]), opts);
  const up = conditionalVolFromPriceHistory(windowEndingIn([1 / 0.93, 1 / 0.92, 1 / 0.94, 1 / 0.91]), opts);
  assert.ok(down.A.conditionalVol > up.A.conditionalVol,
    `drawdown (${down.A.conditionalVol}) > mirror rally (${up.A.conditionalVol})`);
});

test('conditionalVolFromPriceHistory: GJR read is deterministic and MLE-routed', () => {
  const src = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.03 }, seed: 5 });
  const frames = [src.current()];
  for (let i = 0; i < 60; i += 1) frames.push(src.tick());
  const a = conditionalVolFromPriceHistory(frames, { kind: 'gjr-garch', estimate: 'mle' });
  const b = conditionalVolFromPriceHistory(frames, { kind: 'gjr-garch', estimate: 'mle' });
  assert.deepEqual(a, b, 'byte-identical for identical input (no RNG)');
  assert.ok(a.A.conditionalVol > 0 && a.A.gamma != null && a.A.gamma >= 0, 'gamma is estimated and non-negative');
});

test('conditionalVolFromPriceHistory: an EGARCH read carries the signed leverage fit', () => {
  const source = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Egarch11Surface({ A: { omega: -0.45, alpha: 0.16, gamma: -0.2, beta: 0.9 } }),
    seed: 17,
  });
  const frames = [source.current()];
  for (let i = 0; i < 800; i += 1) frames.push(source.tick());
  const read = conditionalVolFromPriceHistory(frames, { kind: 'egarch', estimate: 'mle' });
  assert.ok(read.A.gamma < -0.05, `the signed leverage fit is carried into the live read (got ${read.A.gamma})`);
  assert.ok(read.A.conditionalVol > 0, 'the live read rolls EGARCH forward');
});

test('auto-egarch: selects EGARCH only on measured signed asymmetry', () => {
  const leverage = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Egarch11Surface({ A: { omega: -0.45, alpha: 0.16, gamma: -0.2, beta: 0.9 } }),
    seed: 17,
  });
  const symmetric = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Garch11Surface({ A: { omega: 0.00015, alpha: 0.09, beta: 0.85 } }),
    seed: 17,
  });
  const history = (feed) => {
    const frames = [feed.current()];
    for (let i = 0; i < 800; i += 1) frames.push(feed.tick());
    return frames;
  };
  const leverageFrames = history(leverage);
  const leverageSelection = autoEgarchMleFromPriceHistory(leverageFrames, { selection: 'gamma' }).stats('A');
  const symmetricSelection = autoEgarchMleFromPriceHistory(history(symmetric), { selection: 'gamma' }).stats('A');
  assert.equal(leverageSelection.model, 'egarch');
  assert.ok(leverageSelection.gamma < -0.05, `material signed gamma selects EGARCH (got ${leverageSelection.gamma})`);
  assert.equal(symmetricSelection.model, 'garch');

  const read = conditionalVolFromPriceHistory(leverageFrames, { kind: 'auto-egarch', selection: 'gamma' });
  assert.equal(read.A.model, 'egarch', 'the analyzer-regime read takes the same selected model');
});

test('auto-egarch: held-out QLIKE chooses the production surface and reaches the regime read', () => {
  const symmetric = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Garch11Surface({ A: { omega: 0.00015, alpha: 0.09, beta: 0.85 } }),
    seed: 1,
  });
  const leverage = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Egarch11Surface({ A: { omega: -0.45, alpha: 0.16, gamma: -0.2, beta: 0.9 } }),
    seed: 17,
  });
  const history = (feed) => {
    const frames = [feed.current()];
    for (let index = 0; index < 800; index += 1) frames.push(feed.tick());
    return frames;
  };
  const symmetricFrames = history(symmetric);
  const leverageFrames = history(leverage);
  const symmetricSelection = autoEgarchMleFromPriceHistory(symmetricFrames).stats('A');
  const leverageSelection = autoEgarchMleFromPriceHistory(leverageFrames).stats('A');

  assert.equal(symmetricSelection.selection, 'oos-qlike');
  assert.equal(symmetricSelection.model, 'garch');
  assert.ok(symmetricSelection.oosQlike.garch < symmetricSelection.oosQlike.egarch);
  assert.equal(leverageSelection.selection, 'oos-qlike');
  assert.equal(leverageSelection.model, 'egarch');
  assert.ok(leverageSelection.oosQlike.egarch < leverageSelection.oosQlike.garch);

  const read = conditionalVolFromPriceHistory(leverageFrames, { kind: 'auto-egarch' });
  assert.equal(read.A.selection, 'oos-qlike');
  assert.deepEqual(read.A.oosQlike, leverageSelection.oosQlike);
});

test('auto-egarch: a short window does not mistake fallback gamma for evidence', () => {
  const source = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.02 }, seed: 9 });
  const frames = [source.current()];
  for (let i = 0; i < 6; i += 1) frames.push(source.tick());
  const selection = autoEgarchMleFromPriceHistory(frames).stats('A');
  assert.equal(selection.model, 'garch');
  assert.equal(selection.selection, 'gamma-fallback');
  assert.equal(selection.oosQlike, undefined);
});
