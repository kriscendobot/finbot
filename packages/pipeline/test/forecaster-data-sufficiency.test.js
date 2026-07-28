import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  project,
  projectionArtifact,
  projectionId,
  computeDataSufficiency,
} from '../forecaster.js';
import { makeWorld } from '@finbot/simulator/world';

// The forecast data-sufficiency signal: name whether a projection outruns its
// observed evidence. The forecaster projects `horizon` ticks forward from a
// window of observed price frames; a horizon that exceeds the observed returns
// is extrapolating past its data. This closes the ensemble-forecasting design's
// open question ("name the data scarcity in the result and let the planner
// downweight"). Off by default → the projection is byte-identical to before.

// A 16-frame series (15 observable returns) with a late vol cluster; its
// plain-GARCH fit pins the fixed 0.08 / 0.90 split → persistence exactly 0.98.
const DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];

function readingsOf(series) {
  return series.map((p, i) => ({ t: i, prices: { ATOM: p } }));
}

function worldFor(tag) {
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: DIP[DIP.length - 1] },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: DIP[DIP.length - 1] }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag,
  });
}

test('computeDataSufficiency: coverage is observed returns per projected tick', () => {
  const frames = readingsOf(DIP).map((r) => r.prices);
  const ds = computeDataSufficiency({ frames, horizon: 5, minCoverage: 1 });
  assert.equal(ds.historyFrames, 16);
  assert.equal(ds.historyReturns, 15);
  assert.equal(ds.horizon, 5);
  assert.equal(ds.coverageRatio, 3); // 15 returns / 5 ticks
  assert.equal(ds.scarce, false);

  // A horizon that outruns the window is scarce (coverage < minCoverage).
  const thin = computeDataSufficiency({ frames: frames.slice(0, 4), horizon: 20, minCoverage: 1 });
  assert.equal(thin.historyReturns, 3);
  assert.equal(thin.coverageRatio, 0.15);
  assert.equal(thin.scarce, true);

  // Accepts a bare frame count too, and a zero horizon never divides by zero.
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 4 }).coverageRatio, 1.75);
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 0 }).coverageRatio, 0);
});

test('project: off by default — no dataSufficiency field, artifact byte-identical', () => {
  const window = readingsOf(DIP);
  const base = project(
    { world: worldFor('ds-off-a'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false },
  );
  assert.equal(base.dataSufficiency, null);
  assert.ok(!('dataSufficiency' in projectionArtifact(base)));

  // A second run with the flag ON must NOT change the artifact/id of the data
  // the projection already carried (the field is additive, never mutating).
  const reported = project(
    { world: worldFor('ds-off-a'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  // The base (no-report) id equals a projection built by stripping the added field.
  const strippedArtifact = projectionArtifact(reported);
  delete strippedArtifact.dataSufficiency;
  assert.deepEqual(strippedArtifact, projectionArtifact(base));
  assert.equal(projectionId(base), projectionId({ ...reported, dataSufficiency: null }));
});

test('project: reported coverage is deterministic and tracks the horizon', () => {
  const window = readingsOf(DIP); // 16 frames → 15 returns
  const run = () => project(
    { world: worldFor('ds-on'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  const a = run();
  const b = run();
  assert.equal(a.dataSufficiency.historyReturns, 15);
  assert.equal(a.dataSufficiency.horizon, 5);
  assert.equal(a.dataSufficiency.coverageRatio, 3);
  assert.equal(a.dataSufficiency.scarce, false);
  // Same inputs → byte-identical descriptor (determinism contract).
  assert.deepEqual(a.dataSufficiency, b.dataSufficiency);
  assert.equal(projectionId(a), projectionId(b));
});

test('project: a scarce window (horizon outruns observations) flags scarce', () => {
  const window = readingsOf(DIP.slice(0, 4)); // 4 frames → 3 returns
  const p = project(
    { world: worldFor('ds-scarce'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 20, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  assert.equal(p.dataSufficiency.historyReturns, 3);
  assert.equal(p.dataSufficiency.coverageRatio, 0.15);
  assert.equal(p.dataSufficiency.scarce, true);
  // The added field lands in the hashed artifact only when reported.
  assert.ok('dataSufficiency' in projectionArtifact(p));
});

test('project: a regime-stretched horizon lowers the coverage it must justify', () => {
  const window = readingsOf(DIP); // persistence 0.98 under a plain-GARCH fit
  const common = {
    ensembleSize: 8, baseSeed: 100, render: false,
    adaptiveVol: { kind: 'garch' }, reportDataSufficiency: true,
  };
  const unstretched = project(
    { world: worldFor('ds-regime-a'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ...common, horizon: 5, regimeHorizonStretch: 0 },
  );
  const stretched = project(
    { world: worldFor('ds-regime-b'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ...common, horizon: 5, regimeHorizonStretch: 0.5 },
  );
  // The persistent regime stretched the horizon (5 → 8), so the SAME observed
  // window now justifies a deeper projection — coverage falls accordingly.
  assert.ok(stretched.horizon > unstretched.horizon);
  assert.equal(stretched.dataSufficiency.horizon, stretched.horizon);
  assert.ok(stretched.dataSufficiency.coverageRatio < unstretched.dataSufficiency.coverageRatio);
  assert.equal(stretched.dataSufficiency.coverageRatio, computeDataSufficiency({
    frames: window.map((r) => r.prices), horizon: stretched.horizon,
  }).coverageRatio);
});
