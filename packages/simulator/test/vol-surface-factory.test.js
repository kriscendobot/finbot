import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeVolSurface, makeWorld, makePriceFeed } from '../world.js';
import { Garch11Surface } from '../garch.js';
import { GjrGarch11Surface } from '../gjr-garch.js';
import { Egarch11Surface } from '../egarch.js';
import { GBMPriceFeed } from '../price-feed.js';

test('makeVolSurface: null / undefined -> null (plain GBM, no surface)', () => {
  assert.equal(makeVolSurface(null), null);
  assert.equal(makeVolSurface(undefined), null);
});

test('makeVolSurface: passes an already-constructed surface through untouched', () => {
  const surf = new Garch11Surface({ A: { omega: 0.0002, alpha: 0.1, beta: 0.85 } });
  assert.equal(makeVolSurface(surf), surf);
  const gjr = new GjrGarch11Surface({ A: { omega: 0.0002, alpha: 0.05, gamma: 0.1, beta: 0.8 } });
  assert.equal(makeVolSurface(gjr), gjr);
});

test('makeVolSurface: garch descriptor from explicit params', () => {
  const surf = makeVolSurface({ kind: 'garch', params: { A: { omega: 0.001, alpha: 0.1, beta: 0.8 } } });
  assert.equal(surf.isGarch, true);
  assert.equal(surf.has('A'), true);
});

test('makeVolSurface: garch descriptor variance-targets from a base vol', () => {
  const sigma = 0.05;
  const surf = makeVolSurface({ kind: 'garch', volatilities: { A: sigma } });
  assert.equal(surf.isGarch, true);
  // sigma0 pinned to the base vol, so a fresh trajectory starts at sigma^2.
  assert.ok(Math.abs(surf.initialVariance('A') - sigma * sigma) < 1e-15);
  // unconditional vol equals the base vol (variance targeting).
  const s = surf.stats('A');
  assert.ok(Math.abs(s.unconditionalVol - sigma) < 1e-12, 'unconditional vol == base vol');
});

test('makeVolSurface: garch descriptor fit from a price history', () => {
  const history = [];
  let p = 100;
  const rng = (() => { let s = 5; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  for (let i = 0; i < 200; i += 1) {
    p *= Math.exp((rng() - 0.5) * 0.04);
    history.push({ A: p });
  }
  const surf = makeVolSurface({ kind: 'garch', history });
  assert.equal(surf.isGarch, true);
  assert.ok(surf.initialVariance('A') > 0);
});

test('makeVolSurface: gjr-garch descriptor carries the leverage gamma', () => {
  const surf = makeVolSurface({ kind: 'gjr-garch', volatilities: { A: 0.04 }, gamma: 0.12 });
  assert.ok(surf instanceof GjrGarch11Surface);
  assert.equal(surf.isGarch, true);
  assert.ok(Math.abs(surf.params.A.gamma - 0.12) < 1e-15);
});

test('makeVolSurface: egarch descriptor from explicit params', () => {
  const surf = makeVolSurface({ kind: 'egarch', params: { A: { omega: -0.2, alpha: 0.15, gamma: -0.08, beta: 0.95 } } });
  assert.ok(surf instanceof Egarch11Surface);
  assert.equal(surf.isGarch, true);
  assert.ok(Math.abs(surf.params.A.gamma - -0.08) < 1e-15);
});

test('makeVolSurface: egarch descriptor fit from a price history', () => {
  const src = makePriceFeed({ kind: 'gbm', initialPrices: { A: 100 }, volatilities: { A: 0.03 }, seed: 5 });
  const history = [src.current()];
  for (let i = 0; i < 200; i += 1) history.push(src.tick());
  const surf = makeVolSurface({ kind: 'egarch', history });
  assert.ok(surf instanceof Egarch11Surface);
  assert.ok(surf.stats('A').downWeight > surf.stats('A').upWeight, 'default fit keeps a leverage asymmetry');
});

test('makeVolSurface: unknown kind and under-specified descriptors throw', () => {
  assert.throws(() => makeVolSurface({ kind: 'nope' }), /unknown volSurface kind/);
  assert.throws(() => makeVolSurface({ kind: 'garch' }), /needs one of/);
  assert.throws(() => makeVolSurface({ kind: 'empirical' }), /needs a { history }/);
  assert.throws(() => makeVolSurface({ kind: 'egarch' }), /needs one of { params, history }/);
});

test('makePriceFeed: a garch volSurface descriptor builds a GARCH-driven feed', () => {
  const feed = makePriceFeed({
    kind: 'gbm',
    initialPrices: { A: 100 },
    volatilities: { A: 0.03 },
    seed: 7,
    volSurface: { kind: 'garch', volatilities: { A: 0.03 } },
  });
  assert.equal(feed.isGarch, true);
  assert.ok(feed.garchVar && feed.garchVar.A != null, 'feed carries an evolving conditional variance');
});

test('makeWorld: no volSurface is byte-identical to the prior plain-GBM walk', () => {
  const mk = () => makeWorld({
    portfolio: { cash: 1000, balances: { A: 10 }, initialPrice: 100 },
    priceFeed: { kind: 'gbm', initialPrices: { A: 100 }, volatilities: { A: 0.03 }, seed: 11 },
    seed: 11,
  });
  // A world built through the factory (which now routes volSurface through
  // makeVolSurface(undefined) === null) walks identically to a raw GBM feed.
  const world = mk();
  const raw = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.03 }, seed: 11 });
  for (let i = 0; i < 50; i += 1) {
    const a = world.priceFeed.tick();
    const b = raw.tick();
    assert.equal(a.A, b.A);
  }
});

test('makeWorld: GARCH clustering widens the terminal spread vs constant-vol GBM', () => {
  // Same base vol, same seed schedule: the GARCH feed's conditional variance
  // reacts to shocks (clustering), so its realized returns show a fatter tail
  // than the constant-sigma feed. We assert the GARCH walk's max absolute
  // per-tick log-return exceeds the constant-vol walk's over a long run — a
  // coarse but robust clustering signature.
  const base = 0.03;
  const seed = 123;
  const gbm = makeWorld({
    priceFeed: { kind: 'gbm', initialPrices: { A: 100 }, volatilities: { A: base }, seed },
    seed,
  }).priceFeed;
  const garch = makeWorld({
    priceFeed: {
      kind: 'gbm',
      initialPrices: { A: 100 },
      volatilities: { A: base },
      seed,
      // High-persistence, high-ARCH params so clustering is pronounced.
      volSurface: { kind: 'garch', volatilities: { A: base }, alpha: 0.15, beta: 0.8 },
    },
    seed,
  }).priceFeed;
  let maxGbm = 0;
  let maxGarch = 0;
  let prevG = gbm.current().A;
  let prevH = garch.current().A;
  for (let i = 0; i < 4000; i += 1) {
    const g = gbm.tick().A;
    const h = garch.tick().A;
    maxGbm = Math.max(maxGbm, Math.abs(Math.log(g / prevG)));
    maxGarch = Math.max(maxGarch, Math.abs(Math.log(h / prevH)));
    prevG = g;
    prevH = h;
  }
  assert.ok(maxGarch > maxGbm, `GARCH tail (${maxGarch}) should exceed constant-vol tail (${maxGbm})`);
});

// ---------------------------------------------------------------------------
// auto-gjr-garch: the asymmetric-model selector as a volSurface descriptor
// ---------------------------------------------------------------------------

import { AutoGjrGarchSurface } from '../garch.js';

/** Roll a price feed into per-tick frames { asset: price }. */
function frames(feed, n) {
  const out = [{ ...feed.current() }];
  for (let i = 0; i < n; i += 1) out.push({ ...feed.tick() });
  return out;
}

test('makeVolSurface: auto-gjr-garch with material gamma selects the asymmetric surface', () => {
  const gjsrSurf = new GjrGarch11Surface({ A: { omega: 0.00015, alpha: 0.02, gamma: 0.14, beta: 0.85 } });
  const feed = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: gjsrSurf,
    seed: 7,
  });
  const hist = frames(feed, 800);

  const surf = makeVolSurface({ kind: 'auto-gjr-garch', history: hist });
  assert.ok(surf instanceof AutoGjrGarchSurface);
  assert.equal(surf.has('A'), true);
  assert.equal(surf.stats('A').model, 'gjr-garch');
  assert.ok(Math.abs(surf.stats('A').gamma - 0.14) < 0.04, 'fitted gamma close to ground truth');
});

test('makeVolSurface: auto-gjr-garch with near-zero gamma keeps the symmetric surface', () => {
  const garchSurf = new Garch11Surface({ A: { omega: 0.00015, alpha: 0.09, beta: 0.85 } });
  const feed = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: garchSurf,
    seed: 7,
  });
  const hist = frames(feed, 800);

  const surf = makeVolSurface({ kind: 'auto-gjr-garch', history: hist });
  assert.ok(surf instanceof AutoGjrGarchSurface);
  assert.equal(surf.stats('A').model, 'garch');
});

test('makeVolSurface: auto-gjr-garch requires a history of price frames', () => {
  assert.throws(() => makeVolSurface({ kind: 'auto-gjr-garch' }), /needs a.*history/);
});

test('makeVolSurface: auto-gjr-garch is reproducible across two calls with the same input', () => {
  const surf1 = new GjrGarch11Surface({ A: { omega: 0.00015, alpha: 0.02, gamma: 0.14, beta: 0.85 } });
  const feed = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf1, seed: 7 });
  const hist = frames(feed, 800);

  const a = makeVolSurface({ kind: 'auto-gjr-garch', history: hist });
  const b = makeVolSurface({ kind: 'auto-gjr-garch', history: hist });
  assert.ok(Math.abs(a.stats('A').gamma - b.stats('A').gamma) < 1e-12);
});
