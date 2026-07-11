import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GjrGarch11Surface, gjrGarchFromPriceHistory } from '../gjr-garch.js';
import { Garch11Surface } from '../garch.js';
import { GBMPriceFeed } from '../price-feed.js';

test('GjrGarch11Surface: stats reports asymmetric persistence and unconditional vol', () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.0002, alpha: 0.05, gamma: 0.1, beta: 0.85 } });
  const s = surf.stats('A');
  // persistence = alpha + beta + gamma/2 = 0.05 + 0.85 + 0.05 = 0.95
  assert.ok(Math.abs(s.persistence - 0.95) < 1e-12, 'persistence = alpha + beta + gamma/2');
  // unconditional variance = omega / (1 - persistence) = 0.0002 / 0.05 = 0.004
  assert.ok(Math.abs(s.unconditionalVol - Math.sqrt(0.004)) < 1e-12, 'unconditional vol');
  assert.ok(Math.abs(s.sigma0 - Math.sqrt(0.004)) < 1e-12, 'sigma0 defaults to unconditional');
  assert.ok(Math.abs(s.downWeight - 0.15) < 1e-15, 'downWeight = alpha + gamma');
  assert.ok(Math.abs(s.upWeight - 0.05) < 1e-15, 'upWeight = alpha');
});

test('GjrGarch11Surface: nextVariance is asymmetric — a down-move lifts variance more than an up-move', () => {
  const omega = 0.0002;
  const alpha = 0.05;
  const gamma = 0.1;
  const beta = 0.85;
  const surf = new GjrGarch11Surface({ A: { omega, alpha, gamma, beta } });
  const varNow = 0.004;
  const z = 2.0;
  const up = surf.nextVariance('A', varNow, z);
  const down = surf.nextVariance('A', varNow, -z);
  const expUp = omega + (alpha * z * z + beta) * varNow;
  const expDown = omega + ((alpha + gamma) * z * z + beta) * varNow;
  assert.ok(Math.abs(up - expUp) < 1e-15, 'up-move uses alpha');
  assert.ok(Math.abs(down - expDown) < 1e-15, 'down-move uses alpha + gamma');
  assert.ok(down > up, 'leverage effect: equal-magnitude drop raises variance more than the rise');
});

test('GjrGarch11Surface: gamma = 0 collapses onto symmetric GARCH(1,1)', () => {
  const p = { omega: 0.0003, alpha: 0.1, beta: 0.85 };
  const gjr = new GjrGarch11Surface({ A: { ...p, gamma: 0 } });
  const sym = new Garch11Surface({ A: p });
  for (const z of [-3, -1, -0.2, 0.2, 1, 3]) {
    assert.ok(
      Math.abs(gjr.nextVariance('A', 0.004, z) - sym.nextVariance('A', 0.004, z)) < 1e-18,
      `gamma=0 matches symmetric GARCH at z=${z}`,
    );
  }
});

test('GjrGarch11Surface: non-stationary / malformed params throw', () => {
  assert.throws(() => new GjrGarch11Surface(null), /params must be/);
  assert.throws(
    () => new GjrGarch11Surface({ A: { omega: -1, alpha: 0.1, gamma: 0.1, beta: 0.8 } }),
    /omega must be > 0/,
  );
  // alpha + beta + gamma/2 = 0.4 + 0.5 + 0.1 = 1.0 -> non-stationary
  assert.throws(
    () => new GjrGarch11Surface({ A: { omega: 0.001, alpha: 0.4, gamma: 0.2, beta: 0.5 } }),
    /non-stationary/,
  );
  // alpha + gamma < 0 -> a down-move would reduce variance
  assert.throws(
    () => new GjrGarch11Surface({ A: { omega: 0.001, alpha: 0.1, gamma: -0.3, beta: 0.5 } }),
    /alpha \+ gamma must be >= 0/,
  );
  assert.equal(new GjrGarch11Surface({ A: { omega: 0.001, alpha: 0.1, gamma: 0.05, beta: 0.8 } }).has('B'), false);
});

test('GBMPriceFeed: a GJR-GARCH surface is deterministic given a seed', () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.0004, alpha: 0.05, gamma: 0.15, beta: 0.78 } });
  const mk = () => new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 7 });
  const a = mk();
  const b = mk();
  for (let i = 0; i < 200; i += 1) {
    assert.ok(Math.abs(a.tick().A - b.tick().A) < 1e-12, `tick ${i} identical`);
  }
});

test('GBMPriceFeed: GJR-GARCH shows a negative return/future-vol correlation the symmetric surface lacks', () => {
  // Leverage signature: this tick's return sign correlates *negatively* with
  // next tick's realized squared return. Symmetric GARCH keys off magnitude
  // only, so its sign-correlation sits near zero; GJR-GARCH makes it clearly
  // negative (down-moves precede higher variance).
  const signVolCorr = (feed, n) => {
    const rets = [];
    let prev = feed.current().A;
    for (let i = 0; i < n; i += 1) {
      const p = feed.tick().A;
      rets.push(Math.log(p / prev));
      prev = p;
    }
    // Pair sign(r_t) with r_{t+1}^2, then correlate.
    const xs = [];
    const ys = [];
    for (let i = 0; i + 1 < rets.length; i += 1) {
      xs.push(Math.sign(rets[i]));
      ys.push(rets[i + 1] * rets[i + 1]);
    }
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) * (xs[i] - mx);
      dy += (ys[i] - my) * (ys[i] - my);
    }
    return num / Math.sqrt(dx * dy);
  };
  const gjr = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new GjrGarch11Surface({ A: { omega: 0.00005, alpha: 0.02, gamma: 0.2, beta: 0.77 } }),
    seed: 13,
  });
  const sym = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Garch11Surface({ A: { omega: 0.00005, alpha: 0.12, beta: 0.77 } }),
    seed: 13,
  });
  const gjrCorr = signVolCorr(gjr, 6000);
  const symCorr = signVolCorr(sym, 6000);
  assert.ok(gjrCorr < -0.02, `GJR return-sign vs next squared-return correlation is clearly negative (got ${gjrCorr})`);
  assert.ok(gjrCorr < symCorr - 0.02, `GJR is more asymmetric than symmetric GARCH (${gjrCorr} vs ${symCorr})`);
});

test('GBMPriceFeed: a reseeded fork starts a fresh GJR-GARCH variance path', () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.0004, alpha: 0.05, gamma: 0.2, beta: 0.7 } });
  const parent = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 });
  for (let i = 0; i < 50; i += 1) parent.tick();
  const child = parent.clone({ seed: 999 });
  assert.ok(Math.abs(child.garchVar.A - surf.initialVariance('A')) < 1e-15, 'fresh path resets variance');
  const twin = parent.clone({ seed: 999 });
  for (let i = 0; i < 100; i += 1) {
    assert.ok(Math.abs(child.tick().A - twin.tick().A) < 1e-12);
  }
});

test('GBMPriceFeed: a same-seed clone carries the evolved GJR-GARCH variance forward', () => {
  const surf = new GjrGarch11Surface({ A: { omega: 0.0004, alpha: 0.05, gamma: 0.2, beta: 0.7 } });
  const parent = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 });
  for (let i = 0; i < 40; i += 1) parent.tick();
  const cont = parent.clone();
  assert.ok(Math.abs(cont.garchVar.A - parent.garchVar.A) < 1e-15, 'variance carried, not reset');
  const parentNext = [];
  for (let i = 0; i < 20; i += 1) parentNext.push(parent.tick().A);
  for (let i = 0; i < 20; i += 1) {
    assert.ok(Math.abs(cont.tick().A - parentNext[i]) < 1e-12, `continuation tick ${i} matches`);
  }
});

test('gjrGarchFromPriceHistory: variance targeting pins the unconditional variance to the sample', () => {
  const src = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.04 }, seed: 21 });
  const frames = [src.current()];
  for (let i = 0; i < 500; i += 1) frames.push(src.tick());
  const surf = gjrGarchFromPriceHistory(frames, { alpha: 0.03, gamma: 0.09, beta: 0.85 });
  const s = surf.stats('A');
  // persistence = 0.03 + 0.85 + 0.045 = 0.925
  assert.ok(Math.abs(s.persistence - 0.925) < 1e-12, 'persistence from config');
  assert.ok(Math.abs(s.unconditionalVol - 0.04) < 0.01, `unconditional vol ~ 0.04 (got ${s.unconditionalVol})`);
  assert.ok(Math.abs(s.omega / (1 - s.persistence) - s.unconditionalVol ** 2) < 1e-18, 'omega targets the variance');
  assert.ok(s.downWeight > s.upWeight, 'default fit keeps a leverage asymmetry');
});

test('gjrGarchFromPriceHistory: rejects a non-stationary spec and too-short history', () => {
  const frames = [{ A: 100 }, { A: 101 }, { A: 99 }];
  assert.throws(() => gjrGarchFromPriceHistory(frames, { alpha: 0.5, gamma: 0.2, beta: 0.5 }), /alpha \+ beta \+ gamma\/2 < 1/);
  assert.throws(() => gjrGarchFromPriceHistory([{ A: 100 }]), /at least two/);
});
