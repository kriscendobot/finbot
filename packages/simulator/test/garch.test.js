import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Garch11Surface, garchFromPriceHistory } from '../garch.js';
import { GBMPriceFeed } from '../price-feed.js';

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
