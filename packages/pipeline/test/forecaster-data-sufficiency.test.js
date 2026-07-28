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
// open question about a horizon that exceeds the historical window. The
// descriptor is pure measurement (the threshold belongs to the consumer), and
// it is off by default, so the hashed artifact stays byte-identical to before.

// A 16-frame series (15 observable returns) with a late vol cluster; its
// plain-GARCH fit pins the fixed 0.08 / 0.90 split, so persistence is 0.98.
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
  const sufficiency = computeDataSufficiency({ frames, horizon: 5 });
  assert.equal(sufficiency.historyFrames, 16);
  assert.equal(sufficiency.historyReturns, 15);
  assert.equal(sufficiency.horizon, 5);
  assert.equal(sufficiency.coverageRatio, 3); // 15 returns / 5 ticks

  // A horizon that outruns the window carries thin coverage.
  const thin = computeDataSufficiency({ frames: frames.slice(0, 4), horizon: 20 });
  assert.equal(thin.historyReturns, 3);
  assert.equal(thin.coverageRatio, 0.15);

  // Accepts a bare frame count too, and a zero horizon never divides by zero.
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 4 }).coverageRatio, 1.75);
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 0 }).coverageRatio, 0);
});

test('computeDataSufficiency: carries measurement only — no threshold, no verdict', () => {
  // The operator's threshold must NOT enter the descriptor: it would ride into
  // the hashed artifact and give two byte-identical ensembles two projectionIds
  // purely from a reporting knob. The consumer owns the comparison.
  const sufficiency = computeDataSufficiency({ frames: 8, horizon: 4 });
  assert.deepEqual(Object.keys(sufficiency).sort(), [
    'coverageRatio', 'historyFrames', 'historyReturns', 'horizon', 'worstAsset',
  ]);
});

test('computeDataSufficiency: evidence-free frames cannot pad the coverage', () => {
  // A stalled feed emitting `{ prices: {} }`, or a frame carrying only OTHER
  // assets, is no evidence about the projected asset — counting it would let
  // padding satisfy the gate with no new observations at all.
  const real = readingsOf(DIP.slice(0, 4)).map((r) => r.prices);
  const padding = [{}, {}, {}, {}, {}, {}, {}, {}];
  const other = [{ OSMO: 1 }, { OSMO: 1.1 }, { OSMO: 1.2 }];
  const bare = computeDataSufficiency({ frames: real, horizon: 8, assets: ['ATOM'] });
  const padded = computeDataSufficiency({
    frames: [...real, ...padding, ...other], horizon: 8, assets: ['ATOM'],
  });
  assert.equal(bare.coverageRatio, padded.coverageRatio);
  assert.equal(padded.historyFrames, 4);
  assert.equal(padded.worstAsset, 'ATOM');

  // With no assets named, a frame still needs at least one finite price.
  assert.equal(computeDataSufficiency({ frames: [...real, ...padding], horizon: 8 }).historyFrames, 4);
  assert.equal(computeDataSufficiency({ frames: [{ ATOM: NaN }, { ATOM: 10 }], horizon: 1 }).historyFrames, 1);
});

test('computeDataSufficiency: coverage is the WORST-covered projected asset', () => {
  // A newly-listed instrument inside a long window is the design's motivating
  // case ("a 30-day forecast of a 3-month-old instrument has thin data"); it
  // must not hide behind its better-observed neighbours.
  const frames = DIP.map((p, i) => (i >= DIP.length - 2 ? { ATOM: p, NEW: p } : { ATOM: p }));
  const sufficiency = computeDataSufficiency({ frames, horizon: 20, assets: ['ATOM', 'NEW'] });
  assert.equal(sufficiency.worstAsset, 'NEW');
  assert.equal(sufficiency.historyFrames, 2);
  assert.equal(sufficiency.historyReturns, 1);
  assert.equal(sufficiency.coverageRatio, 0.05);
  // ATOM alone would have read as amply covered.
  assert.equal(computeDataSufficiency({ frames, horizon: 20, assets: ['ATOM'] }).coverageRatio, 0.75);
});

test('computeDataSufficiency: a bare count is guarded, never ToInt32-wrapped', () => {
  // `frames | 0` wraps mod 2^32, so a huge count would read as maximal scarcity.
  assert.equal(computeDataSufficiency({ frames: 2 ** 31, horizon: 10 }).historyFrames, 2 ** 31);
  assert.equal(computeDataSufficiency({ frames: 8.9, horizon: 10 }).historyFrames, 8);
  assert.equal(computeDataSufficiency({ frames: NaN, horizon: 10 }).historyFrames, 0);
  assert.equal(computeDataSufficiency({ frames: -5, horizon: 10 }).historyFrames, 0);
  // A non-finite horizon is normalized rather than hashed as a JSON null.
  const wild = computeDataSufficiency({ frames: 8, horizon: NaN });
  assert.equal(wild.horizon, 0);
  assert.equal(wild.coverageRatio, 0);
});

test('project: off by default — the descriptor is null and the hashed artifact is byte-identical', () => {
  const window = readingsOf(DIP);
  const base = project(
    { world: worldFor('ds-off-a'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false },
  );
  // The KEY is present (null), exactly as it is for horizonRegime; what stays
  // byte-identical is the hashed artifact, not the returned projection object.
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
  const window = readingsOf(DIP); // 16 frames -> 15 returns
  const run = () => project(
    { world: worldFor('ds-on'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  const a = run();
  const b = run();
  assert.equal(a.dataSufficiency.historyReturns, 15);
  assert.equal(a.dataSufficiency.horizon, 5);
  assert.equal(a.dataSufficiency.coverageRatio, 3);
  assert.equal(a.dataSufficiency.worstAsset, 'ATOM');
  // Same inputs -> byte-identical descriptor (determinism contract).
  assert.deepEqual(a.dataSufficiency, b.dataSufficiency);
  assert.equal(projectionId(a), projectionId(b));
});

test('project: a horizon that outruns the window reports thin coverage', () => {
  const window = readingsOf(DIP.slice(0, 4)); // 4 frames -> 3 returns
  const p = project(
    { world: worldFor('ds-scarce'), targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon: 20, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  assert.equal(p.dataSufficiency.historyReturns, 3);
  assert.equal(p.dataSufficiency.coverageRatio, 0.15);
  // The added field lands in the hashed artifact only when reported.
  assert.ok('dataSufficiency' in projectionArtifact(p));
});

test('project: coverage measures the fit window, not the shorter cited window', () => {
  // The claim under test: the descriptor measures the SAME window the adaptive
  // vol fit draws on. `fitReadings` is the longer rolling window when supplied,
  // so the two must be able to DISAGREE here — a fixture where they coincide
  // pins nothing.
  const fitWindow = readingsOf(DIP);             // 16 frames -> 15 returns
  const citedWindow = readingsOf(DIP.slice(-4)); // 4 frames  -> 3 returns
  const p = project(
    {
      world: worldFor('ds-fit-window'),
      targetWeights: { ATOM: 0.5 },
      readings: citedWindow,
      fitReadings: fitWindow,
    },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  assert.equal(p.dataSufficiency.historyFrames, 16);
  assert.equal(p.dataSufficiency.historyReturns, 15);
  assert.equal(p.dataSufficiency.coverageRatio, 3);
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
  // The persistent regime stretched the horizon (5 -> 8), so the SAME observed
  // window now justifies a deeper projection — coverage falls accordingly.
  assert.ok(stretched.horizon > unstretched.horizon);
  assert.equal(stretched.dataSufficiency.horizon, stretched.horizon);
  assert.ok(stretched.dataSufficiency.coverageRatio < unstretched.dataSufficiency.coverageRatio);
  assert.equal(stretched.dataSufficiency.coverageRatio, computeDataSufficiency({
    frames: window.map((r) => r.prices), horizon: stretched.horizon, assets: ['ATOM'],
  }).coverageRatio);
});
