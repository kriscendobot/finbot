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
  const sufficiency = computeDataSufficiency({ frames, horizon: 5, assets: ['ATOM'] });
  assert.equal(sufficiency.historyFrames, 16);
  assert.equal(sufficiency.historyReturns, 15);
  assert.equal(sufficiency.horizon, 5);
  assert.equal(sufficiency.coverageRatio, 3); // 15 returns / 5 ticks

  // A horizon that outruns the window carries thin coverage.
  const thin = computeDataSufficiency({ frames: frames.slice(0, 4), horizon: 20, assets: ['ATOM'] });
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

  // A non-finite price is a sentinel, not an observation.
  assert.equal(computeDataSufficiency({
    frames: [{ ATOM: NaN }, { ATOM: 10 }], horizon: 1, assets: ['ATOM'],
  }).historyFrames, 1);
});

test('computeDataSufficiency: with NO asset nameable, the measurement is zero — never a portfolio-wide count', () => {
  // Regression: a "counts as observed if the frame carries at least one own
  // positive price" fallback is strictly MORE permissive than every per-asset
  // path around it, because with no asset set no predicate can tell a price from
  // any other positive number. A stalled feed emitting `{ observedAtTick: n }`
  // observes no price at all and measured FULL coverage under that rule — enough
  // to clear an armed `dataSufficiencyMinCoverage: 1`.
  const stalled = Array.from({ length: 21 }, (_unused, n) => ({ observedAtTick: n + 1 }));
  for (const [label, assets] of [['omitted', undefined], ['empty', []], ['null', null]]) {
    const measured = computeDataSufficiency({ frames: stalled, horizon: 20, assets });
    assert.equal(measured.coverageRatio, 0, `assets ${label}`);
    assert.equal(measured.historyFrames, 0, `assets ${label}`);
    assert.equal(measured.historyReturns, 0, `assets ${label}`);
    assert.equal(measured.worstAsset, null, `assets ${label}`);
  }
  // The other spellings of the same padding: an array-shaped frame (own `length`
  // is a positive number) and a boxed string (own indices are not prices).
  for (const frames of [[[1], [1], [1]], [Object('ab'), Object('ab'), Object('ab')]]) {
    assert.equal(computeDataSufficiency({ frames, horizon: 2 }).coverageRatio, 0);
  }
  // And REAL price frames measure zero too when no asset is named: the rule is
  // uniform, not a special case for hostile shapes.
  const real = [{ ATOM: 1 }, { ATOM: 2 }, { ATOM: 3 }];
  assert.equal(computeDataSufficiency({ frames: real, horizon: 4 }).coverageRatio, 0);
  assert.equal(computeDataSufficiency({ frames: real, horizon: 4, assets: ['ATOM'] }).coverageRatio, 0.5);
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

test('computeDataSufficiency: only an OWN, positive price is evidence', () => {
  // An INHERITED price is not an observation this feed made. A prototype-chain
  // read would let frames with zero own properties report full coverage — the
  // same padding `{ prices: {} }` attempts, one lookup deeper.
  const inherited = Array.from({ length: 6 }, () => Object.create({ ATOM: 100 }));
  assert.equal(computeDataSufficiency({ frames: inherited, horizon: 5, assets: ['ATOM'] }).historyFrames, 0);

  // A zero (or negative) price is a stalled-feed sentinel, not an observation:
  // no return can be computed across it.
  const stalled = Array.from({ length: 21 }, () => ({ ATOM: 0 }));
  assert.equal(computeDataSufficiency({ frames: stalled, horizon: 20, assets: ['ATOM'] }).coverageRatio, 0);
  assert.equal(computeDataSufficiency({
    frames: [{ ATOM: -1 }, { ATOM: 10 }], horizon: 1, assets: ['ATOM'],
  }).historyFrames, 1);
});

test('computeDataSufficiency: the OWNNESS check is itself prototype-independent', () => {
  // Regression: the own price is read from its own DESCRIPTOR (so a hostile
  // accessor cannot run inside project()), and the descriptor is then asked for
  // its own `value`. Asking with `'value' in descriptor` reintroduces exactly the
  // substitution the descriptor read exists to refuse: a descriptor is an
  // ordinary object inheriting from Object.prototype, and `in` walks that chain,
  // so ONE polluted `Object.prototype.value` makes every ACCESSOR descriptor —
  // which carries no own `value` — answer with the polluted price.
  const accessorFrames = Array.from({ length: 3 }, () => Object.defineProperty(
    {}, 'ATOM', { get: () => 0, enumerable: true },
  ));
  const clean = computeDataSufficiency({ frames: accessorFrames, horizon: 2, assets: ['ATOM'] });
  assert.equal(clean.coverageRatio, 0);

  Object.prototype.value = 42; // eslint-disable-line no-extend-native
  try {
    const polluted = computeDataSufficiency({
      frames: accessorFrames, horizon: 2, assets: ['ATOM'],
    });
    assert.deepEqual(polluted, clean, 'a polluted Object.prototype.value supplied no evidence');
  } finally {
    delete Object.prototype.value;
  }
});

test('computeDataSufficiency: a return needs two ADJACENT observations', () => {
  // A feed that alternates between assets carries many frames and no returns;
  // counting `historyFrames - 1` would credit it with returns it never observed
  // — the padding defense at one remove, since the frames themselves are real.
  const flapping = Array.from({ length: 42 }, (_, i) => (i % 2 ? { OTHER: 1 } : { ATOM: 1 }));
  const alternating = computeDataSufficiency({ frames: flapping, horizon: 20, assets: ['ATOM'] });
  assert.equal(alternating.historyFrames, 21);
  assert.equal(alternating.historyReturns, 0);
  assert.equal(alternating.coverageRatio, 0);

  // A gap splits the window into runs; only within-run pairs are returns.
  const gappy = computeDataSufficiency({
    frames: [{ ATOM: 10 }, {}, {}, { ATOM: 11 }, { ATOM: 12 }, { ATOM: 13 }], horizon: 4, assets: ['ATOM'],
  });
  assert.equal(gappy.historyFrames, 4);
  assert.equal(gappy.historyReturns, 2); // the 3-frame run, not 4 - 1
  assert.equal(gappy.coverageRatio, 0.5);
});

test('computeDataSufficiency: the worst asset does not depend on the caller key order', () => {
  // `worstAsset` rides into the hashed artifact, so an insertion-order tie-break
  // would make `projectionId` depend on how `targetWeights` happened to be
  // built. Ties break lexicographically instead.
  const frames = [{ A: 1, B: 1 }, { A: 1, B: 1 }];
  assert.equal(computeDataSufficiency({ frames, horizon: 4, assets: ['A', 'B'] }).worstAsset, 'A');
  assert.equal(computeDataSufficiency({ frames, horizon: 4, assets: ['B', 'A'] }).worstAsset, 'A');
  // A genuine difference still wins over the tie-break.
  const thin = [{ A: 1, B: 1 }, { A: 1 }];
  assert.equal(computeDataSufficiency({ frames: thin, horizon: 4, assets: ['A', 'B'] }).worstAsset, 'B');
});

test('computeDataSufficiency: a bare count is guarded, never ToInt32-wrapped', () => {
  // `frames | 0` wraps mod 2^32, so a huge count would read as maximal scarcity.
  assert.equal(computeDataSufficiency({ frames: 2 ** 31, horizon: 10 }).historyFrames, 2 ** 31);
  assert.equal(computeDataSufficiency({ frames: 8.9, horizon: 10 }).historyFrames, 8);
  assert.equal(computeDataSufficiency({ frames: NaN, horizon: 10 }).historyFrames, 0);
  assert.equal(computeDataSufficiency({ frames: -5, horizon: 10 }).historyFrames, 0);
  // Only a number counts as a count; `'8'` is a foreign producer, not a window.
  assert.equal(computeDataSufficiency({ frames: '8', horizon: 10 }).historyFrames, 0);
  // The overload has no frames to measure per asset, so it names none — even
  // when the caller passed assets it cannot honor.
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 10, assets: ['ATOM'] }).worstAsset, null);
});

test('computeDataSufficiency: a horizon that is not a tick count is UNMEASURABLE, not zero', () => {
  // Clamping a non-finite horizon to 0 would mint the one descriptor a consumer
  // reads as "projects nothing, so it cannot outrun its window" out of the input
  // that most outruns it — a NaN horizon from a typo'd flag. `null` says what is
  // true, so a gate reading this evidence fails closed instead of open.
  for (const horizon of [NaN, Infinity, -Infinity, -5, 2.5, '20', null, undefined, {}]) {
    const wild = computeDataSufficiency({ frames: 8, horizon });
    assert.equal(wild.horizon, null, `horizon ${String(horizon)}`);
    assert.equal(wild.coverageRatio, null, `horizon ${String(horizon)}`);
    // The counts are still measured; only the ratio is unavailable.
    assert.equal(wild.historyFrames, 8);
  }
  // A whole, non-negative horizon is measurable, zero included.
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 0 }).horizon, 0);
  assert.equal(computeDataSufficiency({ frames: 8, horizon: 0 }).coverageRatio, 0);
});

test('computeDataSufficiency: untrusted frames cannot forge or abort the measurement', () => {
  // `Array.isArray` says nothing about which `map` a [[Get]] resolves to, and an
  // OWN `map` shadows the primordial. The measurement walks by index instead, so
  // a hijacked method cannot fabricate the coverage mask.
  //
  // Built with `defineProperty`, not assignment: this repo calls
  // `lockdown({ overrideTaming: 'severe' })` in cap-attenuation.js, under which
  // `forged.map = ...` in strict-mode ESM THROWS. A fixture that cannot be
  // constructed in the process the code actually runs in pins nothing; the
  // defineProperty shape is the one that stays reachable post-lockdown.
  const forged = [{ ATOM: 1 }, { ATOM: 1 }, { ATOM: 1 }];
  Object.defineProperty(forged, 'map', {
    value: () => Array.from({ length: 40 }, () => true), configurable: true, writable: true,
  });
  const measured = computeDataSufficiency({ frames: forged, horizon: 20, assets: ['ATOM'] });
  assert.equal(measured.historyFrames, 3);
  assert.equal(measured.historyReturns, 2);

  // An own ACCESSOR is not a data property: `Object.hasOwn` would pass and the
  // read would run the getter, so a hostile frame could throw out of project().
  // Read from the descriptor instead — an accessor simply carries no evidence.
  const hostile = { get ATOM() { throw new Error('boom'); } };
  const guarded = computeDataSufficiency({
    frames: [{ ATOM: 1 }, hostile, { ATOM: 2 }], horizon: 4, assets: ['ATOM'],
  });
  assert.equal(guarded.historyFrames, 2);
  assert.equal(guarded.historyReturns, 0); // the accessor frame splits the run
  // And a window that is ONLY the hostile frame carries no evidence at all.
  assert.equal(computeDataSufficiency({
    frames: [hostile], horizon: 4, assets: ['ATOM'],
  }).historyFrames, 0);
});

test('computeDataSufficiency: the ASSET list is walked by index too, never through its own filter', () => {
  // The sibling hazard, and the one that runs in the GATE-APPROVING direction:
  // `assets.filter` is a [[Get]] on a caller-supplied array exactly as
  // `frames.map` is. An own `filter` that drops the thin constituent narrows the
  // worst-constituent measurement to its better-observed neighbours, and the
  // forged counts stay internally consistent — so the auditor's recompute and its
  // frames-vs-returns cross-check cannot refute them.
  const frames = [{ A: 1 }, { A: 1 }, { A: 1 }, { A: 1, B: 9 }];
  const honest = computeDataSufficiency({ frames, horizon: 4, assets: ['A', 'B'] });
  assert.equal(honest.worstAsset, 'B');
  assert.equal(honest.coverageRatio, 0); // B has 1 frame, so no return: fails an armed gate

  const hijacked = ['A', 'B'];
  Object.defineProperty(hijacked, 'filter', {
    value: () => [], configurable: true, writable: true,
  });
  const measured = computeDataSufficiency({ frames, horizon: 4, assets: hijacked });
  assert.deepEqual(measured, honest, 'the hijacked filter changed nothing');

  // The mirror case: a filter that INVENTS a constituent.
  const inventing = ['A'];
  Object.defineProperty(inventing, 'filter', {
    value: () => ['GHOST'], configurable: true, writable: true,
  });
  assert.equal(computeDataSufficiency({ frames, horizon: 4, assets: inventing }).worstAsset, 'A');

  // And a THROWING trap owes a measurement, not an exception out of project().
  const throwing = ['A'];
  Object.defineProperty(throwing, 'filter', {
    value: () => { throw new Error('boom'); }, configurable: true, writable: true,
  });
  assert.equal(computeDataSufficiency({ frames, horizon: 4, assets: throwing }).worstAsset, 'A');
});

test('computeDataSufficiency: a MALFORMED asset list measures zero, and ANY unnameable element malforms it', () => {
  // A measurement feeding a fail-closed gate degrades toward LESS coverage,
  // never more. Every unknown path here degrades closed.
  const frames = [{ A: 1 }, { A: 1 }, { A: 1 }];
  assert.equal(computeDataSufficiency({ frames, horizon: 4, assets: ['A'] }).coverageRatio, 0.5);
  for (const [label, assets] of [['[42]', [42]], ["'ATOM'", 'ATOM'], ['[Symbol]', [Symbol('A')]],
    ['[{}]', [{}]], ['7', 7], ['[null]', [null]]]) {
    const measured = computeDataSufficiency({ frames, horizon: 4, assets });
    assert.equal(measured.coverageRatio, 0, `assets ${label}`);
    assert.equal(measured.historyFrames, 0);
    assert.equal(measured.worstAsset, null);
  }
  // Regression: a PARTIALLY malformed list must not be silently narrowed to its
  // readable elements. Coverage is the worst-covered constituent, so measuring a
  // SUBSET reports at-least-as-much coverage as measuring the whole — the
  // fail-OPEN direction, on the list that decides what gets measured at all.
  const mixed = [{ A: 1 }, { A: 1 }, { A: 1, B: 9 }];
  assert.equal(computeDataSufficiency({ frames: mixed, horizon: 4, assets: ['A', 'B'] }).coverageRatio, 0);
  for (const assets of [[42, 'A'], ['A', 42], ['A', null], ['A', 'B', {}]]) {
    const measured = computeDataSufficiency({ frames: mixed, horizon: 4, assets });
    assert.equal(measured.coverageRatio, 0, `assets ${JSON.stringify(assets)}`);
    assert.equal(measured.historyFrames, 0);
    assert.equal(measured.worstAsset, null);
  }
});

test('computeDataSufficiency: a hostile FRAMES proxy cannot pad or abort the measurement', () => {
  // `Array.isArray` is proxy-transparent, so the walk's own reads are the last
  // line: an unguarded `frames.length` re-read each iteration lets a growing
  // trap pad the window, and an unguarded index read lets a throwing trap escape
  // as an exception out of `project()` — the failure the sibling helpers' own
  // try/catch exists to forbid.
  const real = [{ ATOM: 1 }];
  let reads = 0;
  // The trap's growth is BOUNDED (it stops climbing at 64). Unbounded, a
  // regression that removed the snapshot would not fail this test — the loop
  // condition would re-read a length that always outruns the index, and the
  // suite would hang instead of reporting a diagnosis. A guard test must fail,
  // not diverge.
  const growing = new Proxy(real, {
    get(target, key, receiver) {
      if (key === 'length') { reads = Math.min(reads + 1, 64); return reads; }
      return Reflect.get(target, key, receiver);
    },
  });
  // The length is snapshotted ONCE, so the window is the one frame that exists.
  assert.equal(computeDataSufficiency({ frames: growing, horizon: 2, assets: ['ATOM'] }).historyFrames, 1);
  assert.equal(reads, 1, 'length was read exactly once');

  const throwing = new Proxy([{ ATOM: 1 }, { ATOM: 1 }], {
    get(target, key, receiver) {
      if (key !== 'length') throw new Error('boom');
      return Reflect.get(target, key, receiver);
    },
  });
  const measured = computeDataSufficiency({ frames: throwing, horizon: 2, assets: ['ATOM'] });
  assert.equal(measured.historyFrames, 0); // a frame that throws on read is not evidence
  assert.equal(measured.coverageRatio, 0);
});

test('computeDataSufficiency: the descriptor is FROZEN, so it cannot drift from the hash', () => {
  // `projectionArtifact` aliases this object into the record whose JSON becomes
  // `projectionId`. A holder mutating it afterwards would leave hash and evidence
  // disagreeing on the one field a fail-closed gate reads.
  const descriptor = computeDataSufficiency({ frames: 8, horizon: 4 });
  assert.ok(Object.isFrozen(descriptor));
  assert.throws(() => { 'use strict'; descriptor.coverageRatio = 99; }, TypeError);
  assert.equal(descriptor.coverageRatio, 1.75);
});

test('computeDataSufficiency: a non-enumerable own price is still an own price', () => {
  // The per-asset read goes through the own descriptor, which is not
  // enumerable-only: a price the feed defined non-enumerably is an observation
  // the feed made, and reading it any other way would make the count depend on a
  // property attribute that says nothing about the evidence.
  const frame = () => Object.defineProperty({}, 'ATOM', { value: 10, enumerable: false });
  const frames = [frame(), frame()];
  assert.equal(computeDataSufficiency({ frames, horizon: 4, assets: ['ATOM'] }).historyFrames, 2);
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

  // The BEFORE arm. Every assertion above compares two runs of the SAME build,
  // so once the field is omitted from the artifact they all pass by construction
  // — and a future change to the artifact shape would move both arms together,
  // leaving the byte-identity claim with nothing pinning it. This literal is the
  // id this exact fixture produced on `origin/main` (verified by running the
  // pre-PR tree), so it is the one arm this build cannot move.
  assert.equal(projectionId(base), '939ffb96c26c0227');
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

test('project: coverage includes residual holdings, not only target weights', () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50, OSMO: 1 }, initialPrice: 10 },
    priceFeed: {
      kind: 'gbm', initialPrices: { ATOM: 10, OSMO: 5 },
      volatilities: { ATOM: 0.02, OSMO: 0.02 }, drifts: { ATOM: 0, OSMO: 0 }, seed: 7,
    },
    seed: 7,
    tag: 'ds-residual-holding',
  });
  const readings = DIP.map((price, index) => ({
    t: index,
    prices: index === DIP.length - 1 ? { ATOM: price, OSMO: 5 } : { ATOM: price },
  }));
  const projection = project(
    { world, targetWeights: { ATOM: 0.5 }, readings },
    { ensembleSize: 8, horizon: 5, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
  assert.equal(projection.dataSufficiency.worstAsset, 'OSMO');
  assert.equal(projection.dataSufficiency.historyReturns, 0);
  assert.equal(projection.dataSufficiency.coverageRatio, 0);
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

test('computeDataSufficiency: a reported length is BOUNDED, not merely snapshotted', () => {
  // `Array.isArray` is true of a Proxy over an array and `length` is writable, so
  // a single honest-looking frame can report `2**53-1`. Snapshotting the length
  // defeats a trap that GROWS; it does nothing about one that starts enormous,
  // and the walk then becomes unbounded synchronous work inside the OODA loop.
  // Every other hostile shape here degrades to "no evidence" in O(1); this one
  // must degrade too. Truncation is the fail-CLOSED direction: a shorter window
  // carries fewer returns, hence less coverage, never more.
  const huge = new Proxy([{ ATOM: 1 }, { ATOM: 2 }], {
    get(target, key, receiver) {
      if (key === 'length') return Number.MAX_SAFE_INTEGER;
      return Reflect.get(target, key, receiver);
    },
  });
  const startedAt = process.hrtime.bigint();
  const measured = computeDataSufficiency({ frames: huge, horizon: 2, assets: ['ATOM'] });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  // Bounded work, and bounded evidence: the two real frames are all that is
  // observed, and the padding indices read as `undefined` — not as prices.
  assert.equal(measured.historyFrames, 2);
  assert.equal(measured.historyReturns, 1);
  assert.equal(measured.coverageRatio, 0.5);
  assert.ok(elapsedMs < 30_000, `the walk terminated (${elapsedMs.toFixed(0)}ms)`);

  // A plain (non-proxied) array of absurd length is the same hazard with no
  // proxy at all, and must not be walked to its end either.
  const sparse = new Array(2 ** 32 - 1);
  sparse[0] = { ATOM: 1 };
  sparse[1] = { ATOM: 2 };
  assert.equal(computeDataSufficiency({ frames: sparse, horizon: 2, assets: ['ATOM'] }).historyReturns, 1);
});

test('computeDataSufficiency: an absurdly long ASSET list malforms rather than narrowing', () => {
  // The length bound truncates, which is fail-closed for a FRAME window (fewer
  // frames, less coverage) and fail-OPEN for an asset list: worst-of-a-subset is
  // at least worst-of-the-whole, so a truncated list would report at-least-as-
  // much coverage as the real one. A list long enough to be truncated is
  // therefore unmeasurable, not shorter.
  const frames = [{ ATOM: 1 }, { ATOM: 2 }, { ATOM: 3 }];
  const enormous = new Proxy(['ATOM'], {
    get(target, key, receiver) {
      if (key === 'length') return Number.MAX_SAFE_INTEGER;
      return Reflect.get(target, key, receiver);
    },
  });
  const measured = computeDataSufficiency({ frames, horizon: 2, assets: enormous });
  assert.equal(measured.coverageRatio, 0);
  assert.equal(measured.worstAsset, null);
});
