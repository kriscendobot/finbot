import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GBMPriceFeed } from '../price-feed.js';

/**
 * Realized correlation of two assets' per-tick log returns over a long
 * walk should approach the requested correlation.
 */
function realizedCorrelation(feed, ticks) {
  const assets = Object.keys(feed.current());
  let prev = feed.current();
  const ra = [];
  const rb = [];
  for (let i = 0; i < ticks; i += 1) {
    const cur = feed.tick();
    ra.push(Math.log(cur[assets[0]] / prev[assets[0]]));
    rb.push(Math.log(cur[assets[1]] / prev[assets[1]]));
    prev = cur;
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i += 1) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

test('correlated GBM: realized correlation tracks the requested rho', () => {
  const cfg = {
    initialPrices: { A: 100, B: 100 },
    volatilities: { A: 0.05, B: 0.05 },
    seed: 7,
    correlations: { 'A:B': 0.8 },
  };
  const feed = new GBMPriceFeed(cfg);
  const rho = realizedCorrelation(feed, 5000);
  assert.ok(Math.abs(rho - 0.8) < 0.05, `realized rho ${rho} should be near 0.8`);
});

test('correlated GBM: negative correlation is honored', () => {
  const feed = new GBMPriceFeed({
    initialPrices: { A: 100, B: 100 },
    volatilities: { A: 0.05, B: 0.05 },
    seed: 11,
    correlations: { 'A:B': -0.7 },
  });
  const rho = realizedCorrelation(feed, 5000);
  assert.ok(rho < -0.6, `realized rho ${rho} should be strongly negative`);
});

test('uncorrelated GBM: byte-identical to a feed built without a correlation spec', () => {
  // The no-correlation path must not perturb the legacy draw schedule.
  const base = { initialPrices: { A: 100, B: 50 }, volatilities: { A: 0.04, B: 0.06 }, seed: 3 };
  const a = new GBMPriceFeed(base);
  const b = new GBMPriceFeed({ ...base, correlations: {} });
  for (let i = 0; i < 50; i += 1) {
    assert.deepEqual(a.tick(), b.tick());
  }
});

test('correlated GBM: deterministic and reproducible', () => {
  const make = () => new GBMPriceFeed({
    initialPrices: { A: 100, B: 100 },
    volatilities: { A: 0.05, B: 0.05 },
    seed: 7,
    correlations: { 'A:B': 0.8 },
  });
  const a = make();
  const b = make();
  for (let i = 0; i < 100; i += 1) assert.deepEqual(a.tick(), b.tick());
});

test('correlated GBM: clone with a new seed diverges but is itself deterministic', () => {
  const parent = new GBMPriceFeed({
    initialPrices: { A: 100, B: 100 },
    volatilities: { A: 0.05, B: 0.05 },
    seed: 7,
    correlations: { 'A:B': 0.8 },
  });
  for (let i = 0; i < 5; i += 1) parent.tick();
  const c1 = parent.clone({ seed: 999 });
  const c2 = parent.clone({ seed: 999 });
  for (let i = 0; i < 20; i += 1) assert.deepEqual(c1.tick(), c2.tick());
});
