import { test } from 'node:test';
import assert from 'node:assert/strict';

import { project, projectionId } from '../forecaster.js';
import { audit } from '../auditor.js';
import { hashProposal } from '../planner.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// Regressions for the PR #6 re-run panel's round-2 must-fix bundle. Each test
// below fails if a fail-closed guard the panel demanded were deleted:
//
//   item 1  a Proxy `cited_forecasts` whose `length` trap throws must yield a
//           verdict, not an exception out of `audit()`.
//   item 2  a malformed observed-window on the coverage-gate-OFF path must not
//           slice the ENTIRE history — it coerces to the default, byte-identical
//           to before, rather than inflating the oracle/vol-fit window.
//   item 4  an audit config knob that is present but unreadable (own accessor or
//           inherited) fails the gate closed via `config-integrity`, never
//           silently defaulting a safety bound to a possibly-looser built-in.

const DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];
const readingsOf = (series) => series.map((p, i) => ({ t: i, prices: { ATOM: p } }));

function forecastWith(window, horizon) {
  const last = window[window.length - 1].prices.ATOM;
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: last },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: last }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'panel-r2-hardening',
  });
  return project(
    { world, targetWeights: { ATOM: 0.5 }, readings: window },
    { ensembleSize: 8, horizon, baseSeed: 100, render: false, reportDataSufficiency: true },
  );
}

const BASE_PROPOSAL = {
  steps: [], proposal_hash: hashProposal([]), cited_forecasts: ['f'], cited_analyses: ['a'],
};
const auditInput = (proposal, forecast) => ({
  proposal, forecast,
  portfolio: { cash: 1000, balances: { ATOM: 0 } }, prices: { ATOM: 10 }, currentTick: 0,
});

// ----- item 1: a Proxy-length citation list owes a verdict, not a throw -----

test('item 1: a Proxy cited_forecasts whose length trap throws yields a verdict, not an exception', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const hostileCited = new Proxy(['x'], {
    get(target, prop, receiver) {
      if (prop === 'length') throw new Error('hostile length trap');
      return Reflect.get(target, prop, receiver);
    },
  });
  const proposal = { ...BASE_PROPOSAL, steps: [], cited_forecasts: hostileCited };

  // Armed, so the data-sufficiency gate exercises citedProjectionIds too.
  let verdict;
  assert.doesNotThrow(() => {
    verdict = audit(auditInput(proposal, forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  }, 'audit must return a verdict for a hostile-length citation list');
  assert.equal(verdict.verdict, 'rejected');
  // Citation-completeness reads the unmeasurable list as empty → fails closed.
  assert.ok(verdict.failed_invariants.includes('citation-completeness'));
});

test('item 1: a hostile per-element citation getter is skipped, not thrown', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const realId = projectionId(forecast);
  // Index 0 throws on read; index 1 is the honest cited id. The throwing element
  // is dropped, and the honest one still binds the descriptor.
  const cited = Object.defineProperties([], {
    0: { get() { throw new Error('hostile element'); }, enumerable: true },
    1: { value: realId, enumerable: true },
    length: { value: 2, enumerable: false },
  });
  const proposal = { ...BASE_PROPOSAL, steps: [], cited_forecasts: cited };
  let verdict;
  assert.doesNotThrow(() => {
    verdict = audit(auditInput(proposal, forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  });
  const sufficiency = verdict.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
  assert.ok(sufficiency, 'the data-sufficiency invariant is emitted');
  // The honest id at index 1 bound the descriptor, so the gate evaluated the
  // coverage rather than fail-closing on an uncited provenance id.
  assert.ok(!/not bound to a forecast artifact/.test(sufficiency.detail));
});

// ----- item 4: an unreadable config knob fails the gate closed -----

test('item 4: an accessor config knob fails closed via config-integrity', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const proposal = { ...BASE_PROPOSAL, cited_forecasts: [projectionId(forecast)] };
  const config = {};
  Object.defineProperty(config, 'tailFloorPct', { get: () => 0.99, enumerable: true });

  const verdict = audit(auditInput(proposal, forecast), config);
  const integrity = verdict.invariant_results.find((r) => r.name === 'config-integrity');
  assert.ok(integrity, 'a config-integrity invariant is emitted for the unreadable knob');
  assert.equal(integrity.pass, false);
  assert.match(integrity.detail, /tailFloorPct/);
  assert.equal(verdict.verdict, 'rejected');
});

test('item 4: an inherited config knob fails closed', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const proposal = { ...BASE_PROPOSAL, cited_forecasts: [projectionId(forecast)] };
  const config = Object.create({ maxStepPct: 0.01 }); // present only via the prototype
  const verdict = audit(auditInput(proposal, forecast), config);
  assert.ok(verdict.invariant_results.find((r) => r.name === 'config-integrity'));
  assert.equal(verdict.verdict, 'rejected');
});

test('item 4: a plain-data config emits NO config-integrity invariant (byte-identical)', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const proposal = { ...BASE_PROPOSAL, cited_forecasts: [projectionId(forecast)] };
  const withKnob = audit(auditInput(proposal, forecast), { tailFloorPct: 0.5 });
  const empty = audit(auditInput(proposal, forecast), {});
  for (const verdict of [withKnob, empty]) {
    assert.equal(
      verdict.invariant_results.find((r) => r.name === 'config-integrity'),
      undefined,
      'a readable/absent knob never adds config-integrity',
    );
  }
});

// ----- item 2: a malformed OFF-path window must not slice the whole history ----

// A 20-frame history; adaptiveVol so the forecast carries a volFit whose
// `frames` reveals exactly how wide the observed window was.
function buildWorldHistory(tag) {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag,
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 20; i += 1) sim.tick();
  return { world, history: sim.history };
}
const OFF_CONFIG = {
  oracle: { thresholdBps: 5 },
  analyzer: { scoreFloor: 0 },
  forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
  auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 21 }, // NOTE: no dataSufficiencyMinCoverage → gate OFF
};

test('item 2: a NaN windowTicks off the coverage gate coerces to the default, not the whole history', async () => {
  const a = buildWorldHistory('r2-nan-window');
  const malformed = await runOodaCycle({
    world: a.world, history: a.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: Number.NaN },
  });
  const b = buildWorldHistory('r2-nan-window');
  const defaulted = await runOodaCycle({
    world: b.world, history: b.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 10 }, // the coerced default
  });
  // Byte-identical to the default window: the malformed value never reached
  // windowFromHistory to slice the entire 20-frame history.
  assert.deepEqual(malformed, defaulted);
  if (malformed.forecast) {
    assert.equal(malformed.forecast.volFit.frames, 10, 'the observed window is the default 10, not the 20-frame history');
  }
});

test('item 2: a malformed fitWindowTicks off the gate is ignored, not sliced whole', async () => {
  const a = buildWorldHistory('r2-nan-fit');
  const malformedFit = await runOodaCycle({
    world: a.world, history: a.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 10, fitWindowTicks: Number.NaN },
  });
  const b = buildWorldHistory('r2-nan-fit');
  const noFit = await runOodaCycle({
    world: b.world, history: b.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 10 },
  });
  assert.deepEqual(malformedFit, noFit);
});
