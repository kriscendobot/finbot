import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forecast } from '../forecast.js';
import { makeWorld } from '../world.js';
import { VolatilitySurface } from '../vol-surface.js';

function world() {
  return makeWorld({
    portfolio: { cash: 500, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.1 }, seed: 1 },
  });
}

test('forecast: emits quantile bands on the tails', () => {
  const r = forecast({ from: world(), horizon: 10, ensembleSize: 60, baseSeed: 100, bins: 8 });
  assert.ok(Array.isArray(r.quantileBands));
  const q99 = r.quantileBands.find((b) => b.q === 0.99);
  const q01 = r.quantileBands.find((b) => b.q === 0.01);
  assert.ok(q99 && q01, 'has p01 and p99 bands');
  assert.ok(q99.lo <= q99.point + 1e-9 && q99.hi >= q99.point - 1e-9);
});

test('forecast: emits path statistics (drawdown + time-to-recovery)', () => {
  const r = forecast({ from: world(), horizon: 15, ensembleSize: 60, baseSeed: 100, bins: 8 });
  assert.ok(r.pathStats);
  assert.ok('maxDrawdownPct' in r.pathStats);
  assert.ok('timeToRecovery' in r.pathStats);
  assert.ok(r.pathStats.recoveryRate >= 0 && r.pathStats.recoveryRate <= 1);
  assert.ok(r.pathStats.maxDrawdownPct.p95 >= r.pathStats.maxDrawdownPct.p50);
  const ddTotal = r.pathStats.maxDrawdownPct.histogram.counts.reduce((a, b) => a + b, 0);
  assert.equal(ddTotal, 60, 'every outcome contributes to the drawdown histogram');
});

test('forecast: per-outcome carries timeToRecovery and recovered', () => {
  const r = forecast({ from: world(), horizon: 12, ensembleSize: 20, baseSeed: 100 });
  for (const o of r.outcomes) {
    assert.ok('recovered' in o);
    assert.ok(o.timeToRecovery === null || typeof o.timeToRecovery === 'number');
  }
});

test('forecast: render attaches a deterministic SVG', () => {
  const r1 = forecast({ from: world(), horizon: 10, ensembleSize: 40, baseSeed: 100, render: true, program: 'p' });
  const r2 = forecast({ from: world(), horizon: 10, ensembleSize: 40, baseSeed: 100, render: true, program: 'p' });
  assert.ok(typeof r1.projectionSvg === 'string' && r1.projectionSvg.startsWith('<svg'));
  assert.equal(r1.projectionSvg, r2.projectionSvg, 'same inputs -> byte-identical SVG');
});

test('forecast: full enriched result is reproducible (determinism contract)', () => {
  const cfg = { from: world(), horizon: 10, ensembleSize: 40, baseSeed: 100, bins: 8, render: true };
  const a = forecast(cfg);
  const b = forecast({ ...cfg, from: world() });
  assert.deepEqual(a.outcomes, b.outcomes);
  assert.deepEqual(a.histogram, b.histogram);
  assert.deepEqual(a.quantileBands, b.quantileBands);
  assert.deepEqual(a.pathStats, b.pathStats);
  assert.equal(a.projectionSvg, b.projectionSvg);
});

test('forecast: correlated multi-asset world runs and stays deterministic', () => {
  const make = () => makeWorld({
    portfolio: { cash: 200, balances: { ATOM: 30, OSMO: 40 }, initialPrice: 10 },
    priceFeed: {
      kind: 'gbm',
      initialPrices: { ATOM: 10, OSMO: 5 },
      volatilities: { ATOM: 0.08, OSMO: 0.12 },
      correlations: { 'ATOM:OSMO': 0.6 },
      seed: 4,
    },
  });
  const a = forecast({ from: make(), horizon: 10, ensembleSize: 30, baseSeed: 100 });
  const b = forecast({ from: make(), horizon: 10, ensembleSize: 30, baseSeed: 100 });
  assert.deepEqual(a.outcomes, b.outcomes);
  assert.equal(a.outcomes.length, 30);
});

test('forecast: vol-surface world runs and stays deterministic', () => {
  const surf = new VolatilitySurface({ ATOM: [0.05, 0.1, 0.2] });
  const make = () => makeWorld({
    portfolio: { cash: 500, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volSurface: surf, seed: 1 },
  });
  const a = forecast({ from: make(), horizon: 10, ensembleSize: 30, baseSeed: 100 });
  const b = forecast({ from: make(), horizon: 10, ensembleSize: 30, baseSeed: 100 });
  assert.deepEqual(a.outcomes, b.outcomes);
});
