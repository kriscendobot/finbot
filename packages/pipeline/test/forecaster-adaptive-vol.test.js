/**
 * Adaptive vol: the forecaster FITS a conditional-volatility surface from the
 * observed oracle window and projects the Monte Carlo ensemble under it, so the
 * projection tracks the volatility regime the cycle actually saw — per
 * instrument — instead of the world's statically-configured (or absent) surface.
 *
 * The prior cycle wired a *statically-named* vol surface from driver config
 * through to the ensemble; this closes the loop by making the surface adaptive
 * to the live window. The default (no `adaptiveVol`) path stays byte-identical,
 * and a too-short / degenerate window falls back to the unadapted world rather
 * than sinking the cycle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { project, projectionArtifact, projectionId, priceFramesFromReadings } from '../forecaster.js';

// A low-vol world (constant sigma 0.02): the world's own feed is calm.
function calmWorld(seed) {
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed },
    seed,
  });
}

// A deterministic window whose realized vol is far above the world's 0.02 —
// alternating ~6% log-return shocks — so a surface fit from it visibly reshapes
// the ensemble. `n` frames of { t, prices: { ATOM } }.
function turbulentReadings(n = 14) {
  const readings = [];
  let price = 10;
  for (let t = 0; t < n; t += 1) {
    readings.push({ t, prices: { ATOM: price } });
    const shock = (t % 2 === 0 ? 0.06 : -0.06);
    price *= Math.exp(shock);
  }
  return readings;
}

const BOUNDS = { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 };
const TARGET = { ATOM: 0.3 };
const histJson = (f) => JSON.stringify(f.histogram);

test('priceFramesFromReadings extracts the per-tick price maps', () => {
  const frames = priceFramesFromReadings([{ t: 0, prices: { ATOM: 10 } }, { t: 1, prices: { ATOM: 11 } }, { t: 2 }]);
  assert.deepEqual(frames, [{ ATOM: 10 }, { ATOM: 11 }]); // the frame with no prices is dropped
});

test('adaptive GARCH fit from the observed window reshapes the ensemble', () => {
  const readings = turbulentReadings();
  const plain = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings },
    { ensembleSize: 60, horizon: 12, baseSeed: 100 },
  );
  const adaptive = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings },
    { ensembleSize: 60, horizon: 12, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  );

  // A turbulent window fit into a GARCH surface widens the projected tails
  // relative to the calm constant-sigma feed: different histogram, same seed.
  assert.notEqual(histJson(plain), histJson(adaptive));
  assert.ok(adaptive.summary.p05 <= plain.summary.p05, 'fitting the turbulent window should not shrink the lower tail');

  // The fit is surfaced for the citation trail, with a per-asset regime summary.
  assert.equal(plain.volFit, null);
  assert.ok(adaptive.volFit, 'adaptive projection carries a volFit');
  assert.equal(adaptive.volFit.kind, 'garch');
  assert.equal(adaptive.volFit.source, 'observed-window');
  assert.equal(adaptive.volFit.frames, readings.length);
  assert.ok(adaptive.volFit.assets.ATOM.unconditionalVol > 0.04, 'fit vol reflects the ~6% turbulent window, not the 2% world');
});

test('adaptive fit is deterministic (same window + seeds -> byte-identical)', () => {
  const readings = turbulentReadings();
  const a = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings },
    { ensembleSize: 50, horizon: 10, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  );
  const b = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings },
    { ensembleSize: 50, horizon: 10, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  );
  assert.deepEqual(a.histogram.counts, b.histogram.counts);
  assert.equal(projectionId(a), projectionId(b));
  assert.deepEqual(a.volFit, b.volFit);
});

test('gjr-garch adaptive fit is accepted and carries an asymmetric regime summary', () => {
  const readings = turbulentReadings();
  const f = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings },
    { ensembleSize: 40, horizon: 10, baseSeed: 100, adaptiveVol: { kind: 'gjr-garch' } },
  );
  assert.equal(f.volFit.kind, 'gjr-garch');
  assert.ok(f.volFit.assets.ATOM.unconditionalVol > 0);
});

test('default path is inert: no adaptiveVol -> no volFit, artifact hash unchanged', () => {
  const readings = turbulentReadings();
  // Same inputs, one WITH readings-but-no-adaptiveVol, one with NEITHER: both
  // must be byte-identical, proving readings alone changes nothing.
  const withReadings = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings },
    { ensembleSize: 40, horizon: 10, baseSeed: 100 },
  );
  const withoutReadings = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS },
    { ensembleSize: 40, horizon: 10, baseSeed: 100 },
  );
  assert.equal(withReadings.volFit, null);
  // The canonical artifact must NOT carry a volFit key on the default path, so
  // the content hash (and the auditor's recompute-and-compare) is unchanged.
  assert.equal(Object.prototype.hasOwnProperty.call(projectionArtifact(withReadings), 'volFit'), false);
  assert.equal(projectionId(withReadings), projectionId(withoutReadings));
});

test('degenerate windows fall back to the unadapted world (no throw)', () => {
  const base = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS },
    { ensembleSize: 40, horizon: 10, baseSeed: 100 },
  );

  // Too-short window: only one frame -> cannot fit -> unadapted.
  const short = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings: [{ t: 0, prices: { ATOM: 10 } }] },
    { ensembleSize: 40, horizon: 10, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  );
  assert.equal(short.volFit, null);
  assert.deepEqual(short.histogram.counts, base.histogram.counts);

  // Constant-price window: degenerate (zero) variance -> fitter guards to a
  // floor rather than throwing; either way the cycle must not blow up.
  const flat = [];
  for (let t = 0; t < 8; t += 1) flat.push({ t, prices: { ATOM: 10 } });
  const flatProj = project(
    { world: calmWorld(7), targetWeights: TARGET, bounds: BOUNDS, readings: flat },
    { ensembleSize: 40, horizon: 10, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  );
  assert.ok(flatProj.histogram.counts.reduce((a, b) => a + b, 0) === 40, 'a flat window still yields a full ensemble');
});
