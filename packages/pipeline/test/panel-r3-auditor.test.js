import { test } from 'node:test';
import assert from 'node:assert/strict';

import { project, projectionId } from '../forecaster.js';
import { audit } from '../auditor.js';
import { hashProposal } from '../planner.js';
import { makeWorld } from '@finbot/simulator/world';

// Regressions for the PR #6 round-3 panel's auditor fail-open must-fix bundle.
// Each test reddens if the guard it pins is reverted:
//
//   M1  dataSufficiencyMinCoverage read through readConfigKnob, so an INHERITED
//       threshold ARMS the gate rather than reading as undefined → silently OFF.
//   M2  a hostile/absent/throwing `steps` yields a verdict, not an exception.
//   3b  a non-finite bound knob (NaN/±Infinity) fails config-integrity closed.
//   3b  a NaN/string step field fails risk-bound-compliance closed.

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
    tag: 'panel-r3-auditor',
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

// ----- M1: an inherited dataSufficiencyMinCoverage ARMS the gate -----

test('M1: an inherited dataSufficiencyMinCoverage arms the gate (not silently OFF)', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const proposal = { ...BASE_PROPOSAL, cited_forecasts: [projectionId(forecast)] };
  // Present ONLY via the prototype — the inline own-descriptor snapshot read this
  // as `undefined`, which `coverageGateArmed` treated as OFF, silently disarming
  // the whole data-sufficiency gate.
  const inherited = audit(auditInput(proposal, forecast), Object.create({ dataSufficiencyMinCoverage: 1 }));
  const gate = inherited.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
  assert.ok(gate, 'an inherited threshold ARMS the gate and emits the invariant');
  assert.equal(gate.pass, false, 'an unreadable threshold arms AND fails closed');
  assert.equal(inherited.verdict, 'rejected');

  // A plain-data config with no threshold leaves the gate off (byte-identical).
  const off = audit(auditInput(proposal, forecast), {});
  assert.equal(off.invariant_results.find((r) => r.name === 'forecast-data-sufficiency'), undefined);
});

// ----- M2: hostile `steps` shapes each owe a verdict, not an exception -----

test('M2: hostile steps shapes each yield a rejected verdict, not an exception', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const base = { proposal_hash: hashProposal([{ asset: 'ATOM' }]), cited_forecasts: ['f'], cited_analyses: ['a'] };

  const proxyLength = new Proxy([{ asset: 'ATOM', side: 'buy', qty: 1, price: 10, notional: 10 }], {
    get(target, prop, receiver) {
      if (prop === 'length') throw new Error('hostile length trap');
      return Reflect.get(target, prop, receiver);
    },
  });
  const throwingAccessor = { ...base };
  Object.defineProperty(throwingAccessor, 'steps', {
    get() { throw new Error('hostile steps accessor'); }, enumerable: true,
  });

  const shapes = {
    'steps absent': { ...base },
    'steps a number': { ...base, steps: 42 },
    'steps a string': { ...base, steps: 'nope' },
    'steps a Proxy whose length trap throws': { ...base, steps: proxyLength },
    'steps a throwing own accessor': throwingAccessor,
  };
  for (const [label, proposal] of Object.entries(shapes)) {
    let verdict;
    assert.doesNotThrow(
      () => { verdict = audit(auditInput(proposal, forecast), { tailFloorPct: 0.5 }); },
      `audit must return a verdict for ${label}, not throw`,
    );
    assert.equal(verdict.verdict, 'rejected', `${label} → rejected`);
  }
});

// ----- 3b: config-integrity usability + step-field narrowing -----

test('3b saboteur#4: a non-finite bound knob fails the gate closed via config-integrity', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  const proposal = { ...BASE_PROPOSAL, cited_forecasts: [projectionId(forecast)] };
  // A readable NaN maxStepPct is not a usable bound: `notional > NaN` never trips.
  const verdict = audit(auditInput(proposal, forecast), { maxStepPct: Number.NaN });
  const integrity = verdict.invariant_results.find((r) => r.name === 'config-integrity');
  assert.ok(integrity, 'a non-finite bound emits config-integrity');
  assert.equal(integrity.pass, false);
  assert.match(integrity.detail, /maxStepPct/);
  assert.equal(verdict.verdict, 'rejected');
});

test('3b saboteur#3: a NaN/string step field fails risk-bound-compliance closed', () => {
  const forecast = forecastWith(readingsOf(DIP), 5);
  for (const bad of [Number.NaN, 'lots', undefined]) {
    const step = { asset: 'ATOM', side: 'buy', qty: 1, price: 10, notional: bad };
    const proposal = {
      steps: [step], proposal_hash: hashProposal([step]),
      cited_forecasts: ['f'], cited_analyses: ['a'],
    };
    let verdict;
    assert.doesNotThrow(() => {
      verdict = audit(auditInput(proposal, forecast), { tailFloorPct: 0.5 });
    }, `a ${String(bad)} notional owes a verdict, not a throw`);
    const risk = verdict.invariant_results.find((r) => r.name === 'risk-bound-compliance');
    assert.equal(risk.pass, false, `a ${String(bad)} notional fails risk-bound-compliance closed`);
    assert.equal(verdict.verdict, 'rejected');
  }
});
