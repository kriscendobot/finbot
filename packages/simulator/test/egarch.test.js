import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Egarch11Surface, egarchFromPriceHistory } from '../egarch.js';
import { Garch11Surface } from '../garch.js';
import { GBMPriceFeed } from '../price-feed.js';

const EABS_Z = Math.sqrt(2 / Math.PI);

test('Egarch11Surface: stats reports log-variance persistence and unconditional vol', () => {
  const omega = -0.2;
  const alpha = 0.15;
  const gamma = -0.08;
  const beta = 0.95;
  const surf = new Egarch11Surface({ A: { omega, alpha, gamma, beta } });
  const s = surf.stats('A');
  // EGARCH persistence is just beta.
  assert.ok(Math.abs(s.persistence - beta) < 1e-12, 'persistence = beta');
  // Unconditional log-variance = omega / (1 - beta) = -0.2 / 0.05 = -4; vol = exp(0.5 * -4) = exp(-2).
  assert.ok(Math.abs(s.unconditionalVol - Math.exp(-2)) < 1e-12, 'unconditional vol = exp(0.5*omega/(1-beta))');
  assert.ok(Math.abs(s.sigma0 - Math.exp(-2)) < 1e-12, 'sigma0 defaults to unconditional');
  // gamma < 0 → a down-move carries the larger per-unit-magnitude impact.
  assert.ok(Math.abs(s.downWeight - (alpha - gamma)) < 1e-15, 'downWeight = alpha - gamma');
  assert.ok(Math.abs(s.upWeight - (alpha + gamma)) < 1e-15, 'upWeight = alpha + gamma');
  assert.ok(s.downWeight > s.upWeight, 'gamma < 0 is the leverage sign');
});

test('Egarch11Surface: nextVariance evolves the log-variance by the EGARCH recursion', () => {
  const omega = -0.2;
  const alpha = 0.15;
  const gamma = -0.08;
  const beta = 0.95;
  const surf = new Egarch11Surface({ A: { omega, alpha, gamma, beta } });
  const varNow = Math.exp(-4); // an arbitrary positive variance
  const z = 1.7;
  const logNow = Math.log(varNow);
  const expUp = Math.exp(omega + beta * logNow + alpha * (Math.abs(z) - EABS_Z) + gamma * z);
  const expDown = Math.exp(omega + beta * logNow + alpha * (Math.abs(z) - EABS_Z) + gamma * -z);
  assert.ok(Math.abs(surf.nextVariance('A', varNow, z) - expUp) < 1e-15, 'up-move matches the recursion');
  assert.ok(Math.abs(surf.nextVariance('A', varNow, -z) - expDown) < 1e-15, 'down-move matches the recursion');
});

test('Egarch11Surface: a down-move lifts variance more than an equal up-move (leverage)', () => {
  const surf = new Egarch11Surface({ A: { omega: -0.2, alpha: 0.15, gamma: -0.1, beta: 0.9 } });
  const varNow = Math.exp(-4);
  const z = 2.0;
  const up = surf.nextVariance('A', varNow, z);
  const down = surf.nextVariance('A', varNow, -z);
  assert.ok(down > up, 'leverage effect: equal-magnitude drop raises variance more than the rise');
});

test('Egarch11Surface: gamma = 0 is symmetric in the shock sign (magnitude-only)', () => {
  const surf = new Egarch11Surface({ A: { omega: -0.15, alpha: 0.2, gamma: 0, beta: 0.9 } });
  const varNow = Math.exp(-3);
  for (const z of [0.2, 1, 3]) {
    assert.ok(
      Math.abs(surf.nextVariance('A', varNow, z) - surf.nextVariance('A', varNow, -z)) < 1e-18,
      `gamma=0 is sign-symmetric at |z|=${z}`,
    );
  }
});

test('Egarch11Surface: a typical-magnitude shock leaves an unconditional surface near its level', () => {
  // With log-variance at its unconditional mean and a shock of exactly E|z|,
  // the magnitude term is zero, so only the (small, signed) gamma term moves it.
  const omega = -0.2;
  const beta = 0.95;
  const surf = new Egarch11Surface({ A: { omega, alpha: 0.15, gamma: 0, beta } });
  const uncondVar = Math.exp(omega / (1 - beta));
  const next = surf.nextVariance('A', uncondVar, EABS_Z);
  assert.ok(Math.abs(Math.log(next) - Math.log(uncondVar)) < 1e-12, 'stays at the unconditional level');
});

test('Egarch11Surface: no coefficient non-negativity constraint, but |beta| < 1 and alpha >= 0 hold', () => {
  // The whole point of the log form: a negative gamma (and negative omega) is
  // fine — the variance is exp(...), positive by construction.
  assert.doesNotThrow(() => new Egarch11Surface({ A: { omega: -3, alpha: 0.1, gamma: -0.5, beta: 0.9 } }));
  assert.throws(() => new Egarch11Surface(null), /params must be/);
  assert.throws(() => new Egarch11Surface({ A: { omega: 0, alpha: -0.1, gamma: 0, beta: 0.5 } }), /alpha must be >= 0/);
  assert.throws(() => new Egarch11Surface({ A: { omega: 0, alpha: 0.1, gamma: 0, beta: 1 } }), /non-stationary/);
  assert.throws(() => new Egarch11Surface({ A: { omega: 0, alpha: 0.1, gamma: 0, beta: -1.2 } }), /non-stationary/);
  assert.throws(() => new Egarch11Surface({ A: { omega: Infinity, alpha: 0.1, gamma: 0, beta: 0.5 } }), /omega must be finite/);
  assert.equal(new Egarch11Surface({ A: { omega: -1, alpha: 0.1, gamma: 0, beta: 0.8 } }).has('B'), false);
});

test('Egarch11Surface: a freak shock is clamped to a finite variance (no exp overflow)', () => {
  const surf = new Egarch11Surface({ A: { omega: 0, alpha: 5, gamma: 0, beta: 0.99 } });
  const next = surf.nextVariance('A', 1e6, 40);
  assert.ok(Number.isFinite(next), 'variance stays finite under an extreme shock');
});

test('GBMPriceFeed: an EGARCH surface is deterministic given a seed', () => {
  const surf = new Egarch11Surface({ A: { omega: -0.3, alpha: 0.15, gamma: -0.1, beta: 0.92 } });
  const mk = () => new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 7 });
  const a = mk();
  const b = mk();
  for (let i = 0; i < 200; i += 1) {
    assert.ok(Math.abs(a.tick().A - b.tick().A) < 1e-12, `tick ${i} identical`);
  }
});

test('GBMPriceFeed: EGARCH shows a negative return/future-vol correlation the symmetric surface lacks', () => {
  // Leverage signature: this tick's return sign correlates *negatively* with
  // next tick's realized squared return. Symmetric GARCH keys off magnitude
  // only, so its sign-correlation sits near zero; EGARCH with gamma < 0 makes
  // it clearly negative (down-moves precede higher variance).
  const signVolCorr = (feed, n) => {
    const rets = [];
    let prev = feed.current().A;
    for (let i = 0; i < n; i += 1) {
      const p = feed.tick().A;
      rets.push(Math.log(p / prev));
      prev = p;
    }
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
  const eg = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Egarch11Surface({ A: { omega: -0.4, alpha: 0.12, gamma: -0.18, beta: 0.9 } }),
    seed: 13,
  });
  const sym = new GBMPriceFeed({
    initialPrices: { A: 100 },
    volSurface: new Garch11Surface({ A: { omega: 0.00005, alpha: 0.12, beta: 0.77 } }),
    seed: 13,
  });
  const egCorr = signVolCorr(eg, 6000);
  const symCorr = signVolCorr(sym, 6000);
  assert.ok(egCorr < -0.02, `EGARCH return-sign vs next squared-return correlation is clearly negative (got ${egCorr})`);
  assert.ok(egCorr < symCorr - 0.02, `EGARCH is more asymmetric than symmetric GARCH (${egCorr} vs ${symCorr})`);
});

test('GBMPriceFeed: a reseeded fork starts a fresh EGARCH variance path', () => {
  const surf = new Egarch11Surface({ A: { omega: -0.3, alpha: 0.15, gamma: -0.1, beta: 0.9 } });
  const parent = new GBMPriceFeed({ initialPrices: { A: 100 }, volSurface: surf, seed: 3 });
  for (let i = 0; i < 50; i += 1) parent.tick();
  const child = parent.clone({ seed: 999 });
  assert.ok(Math.abs(child.garchVar.A - surf.initialVariance('A')) < 1e-15, 'fresh path resets variance');
  const twin = parent.clone({ seed: 999 });
  for (let i = 0; i < 100; i += 1) {
    assert.ok(Math.abs(child.tick().A - twin.tick().A) < 1e-12);
  }
});

test('egarchFromPriceHistory: log-variance targeting pins the unconditional level to the sample', () => {
  const src = new GBMPriceFeed({ initialPrices: { A: 100 }, volatilities: { A: 0.04 }, seed: 21 });
  const frames = [src.current()];
  for (let i = 0; i < 500; i += 1) frames.push(src.tick());
  const surf = egarchFromPriceHistory(frames, { alpha: 0.15, gamma: -0.08, beta: 0.9 });
  const s = surf.stats('A');
  assert.ok(Math.abs(s.persistence - 0.9) < 1e-12, 'persistence = beta from config');
  // The geometric-mean unconditional vol should sit near the source 0.04 sigma.
  assert.ok(Math.abs(s.unconditionalVol - 0.04) < 0.01, `unconditional vol ~ 0.04 (got ${s.unconditionalVol})`);
  // omega pins ln(unconditional variance) to ln(sample variance).
  assert.ok(Math.abs(s.omega / (1 - s.beta) - Math.log(s.unconditionalVol ** 2)) < 1e-12, 'omega targets ln(variance)');
  assert.ok(s.downWeight > s.upWeight, 'default fit keeps a leverage asymmetry');
});

test('egarchFromPriceHistory: is deterministic and tolerates a constant-price asset', () => {
  const frames = [];
  for (let i = 0; i < 20; i += 1) frames.push({ A: 100 + i, B: 50 });
  const a = egarchFromPriceHistory(frames);
  const b = egarchFromPriceHistory(frames);
  assert.deepEqual(a.stats('A'), b.stats('A'), 'same frames → same params');
  assert.ok(Number.isFinite(a.stats('B').omega), 'constant-price asset stays constructible');
  assert.ok(a.initialVariance('B') >= 0, 'constant-price asset has a valid initial variance');
});

test('egarchFromPriceHistory: rejects a non-stationary spec and too-short history', () => {
  const frames = [{ A: 100 }, { A: 101 }, { A: 99 }];
  assert.throws(() => egarchFromPriceHistory(frames, { beta: 1.0 }), /\|beta\| < 1/);
  assert.throws(() => egarchFromPriceHistory([{ A: 100 }]), /at least two/);
});
