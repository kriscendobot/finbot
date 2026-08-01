import { test } from 'node:test';
import assert from 'node:assert/strict';

import { audit } from '../auditor.js';
import { hashProposal } from '../planner.js';

// Regressions for the PR #6 round-4 merge-governance panel's auditor must-fix
// bundle. Each is a NEW fail-open hole where the round-2/3 own-data discipline
// stopped short; each reddens if the guard it pins is reverted:
//
//   M1  a non-NUMBER safety knob ('25%', {}, true, a throwing valueOf) fails the
//       gate closed via a TYPE-scoped config-integrity guard (was value-scoped,
//       so only non-finite *numbers* were caught). Also closes M7 (a forged
//       stalenessWindowTicks can no longer reach the recorded detail).
//   M2  navOf read the portfolio via plain [[Get]] BEFORE the fail-closed
//       snapshot: a throwing accessor threw out of audit(), an inherited
//       `balances` split the view. Compute nav from the own-data snapshot.
//   M3  invariant 6 read `s.route` / `proposal.substrate` via plain [[Get]].
//   M4  invariant 5 (oracleReadings staleness) — non-array threw; a non-numeric
//       observedAtTick / absent currentTick recorded a false `pass: true`.
//   M5  `asset` used as a computed key `balances[asset]` re-invoked untrusted
//       code (throwing toString) / resolved `'__proto__'` to Object.prototype.
//   M6  Array.isArray throws on a revoked Proxy — the one unguarded call.

// A forecast that clears the tail-risk floor for any reasonable NAV, so the
// tests below isolate the invariant each one targets. The data-sufficiency gate
// stays OFF (no dataSufficiencyMinCoverage), so this plain object is enough.
const PASS_FORECAST = { p05Equity: 1e12 };

const baseProposal = (steps) => ({
  steps,
  proposal_hash: hashProposal(steps),
  cited_forecasts: ['f'],
  cited_analyses: ['a'],
});

const inputWith = (proposal, extra = {}) => ({
  proposal,
  forecast: PASS_FORECAST,
  portfolio: { cash: 100, balances: {} },
  prices: { ATOM: 10 },
  currentTick: 0,
  ...extra,
});

const invariant = (verdict, name) => verdict.invariant_results.find((r) => r.name === name);

// ----- M1: a non-number safety knob fails closed (type-scoped, not value-scoped) -----

test('M1: a non-number safety knob emits config-integrity and rejects (no silent fail-open)', () => {
  // A step 100× over the per-step cap. With a value-scoped knob guard, a
  // non-number maxStepPct passed through untouched, `maxStepPct * nav` was NaN,
  // `notional > NaN` was always false, and this audited `approved` with an empty
  // failed_invariants and NO config-integrity invariant.
  const step = { asset: 'ATOM', side: 'buy', qty: 100, price: 10, notional: 1000 };
  for (const bad of ['25%', 'unbounded', {}, true, [], { valueOf() { throw new Error('coerce'); } }]) {
    let verdict;
    assert.doesNotThrow(() => {
      verdict = audit(inputWith(baseProposal([step])), { maxStepPct: bad });
    }, `a ${typeof bad} maxStepPct owes a verdict, not a throw at maxStepPct * nav`);
    const integrity = invariant(verdict, 'config-integrity');
    assert.ok(integrity, `a non-number maxStepPct (${typeof bad}) emits config-integrity`);
    assert.equal(integrity.pass, false);
    assert.match(integrity.detail, /maxStepPct/);
    assert.equal(verdict.verdict, 'rejected');
    assert.ok(verdict.failed_invariants.includes('config-integrity'));
  }
});

test('M1/M7: a forged stalenessWindowTicks knob cannot forge a pricing-freshness line', () => {
  // The knob is now type-checked to a finite number FIRST, so a string forged to
  // splice a line into the record fails config-integrity and never reaches the
  // detail, which interpolates the numeric fallback instead.
  const forged = '5\n- pricing-freshness: FORGED PASS';
  const verdict = audit(
    inputWith(baseProposal([]), { oracleReadings: [{ observedAtTick: 0 }], currentTick: 0 }),
    { stalenessWindowTicks: forged },
  );
  const integrity = invariant(verdict, 'config-integrity');
  assert.ok(integrity && integrity.pass === false, 'a non-number stalenessWindowTicks fails config-integrity');
  assert.match(integrity.detail, /stalenessWindowTicks/);
  for (const r of verdict.invariant_results) {
    assert.doesNotMatch(r.detail, /FORGED PASS/, 'no invariant detail carries the forged line');
  }
});

// ----- M2: the portfolio is snapshotted own-data-only BEFORE nav -----

test('M2: a throwing portfolio cash/balances accessor owes a verdict, not an exception', () => {
  for (const field of ['cash', 'balances']) {
    const portfolio = { cash: 100, balances: { ATOM: 1 } };
    Object.defineProperty(portfolio, field, {
      get() { throw new Error(`hostile ${field} accessor`); },
      enumerable: true,
      configurable: true,
    });
    let verdict;
    assert.doesNotThrow(() => {
      verdict = audit(inputWith(baseProposal([]), { portfolio }), {});
    }, `a throwing ${field} accessor must return a verdict, not throw out of audit()`);
    assert.ok(verdict.verdict === 'approved' || verdict.verdict === 'rejected');
  }
});

test('M2: an inherited `balances` does not split nav from the risk loop', () => {
  // `balances` present ONLY via the prototype: navOf's plain [[Get]] used to
  // resolve it and inflate NAV (so a concentration-busting step read as tiny and
  // approved), while the risk loop's own-read saw nothing. Both now read the same
  // own-data snapshot — an inherited holding contributes to neither.
  const portfolio = Object.create({ balances: { ATOM: 1000 } });
  Object.defineProperty(portfolio, 'cash', { value: 100, enumerable: true });
  const step = { asset: 'ATOM', side: 'buy', qty: 8, price: 10, notional: 80 };
  const verdict = audit(
    inputWith(baseProposal([step]), { portfolio, prices: { ATOM: 10 } }),
    { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 0.5 },
  );
  const risk = invariant(verdict, 'risk-bound-compliance');
  assert.equal(risk.pass, false, 'nav excludes the inherited holding, so the step busts the concentration cap');
  assert.match(risk.detail, /concentration cap/);
  assert.equal(verdict.verdict, 'rejected');
});

// ----- M3: invariant 6 reads route/substrate as own data -----

test('M3: a throwing route/substrate accessor owes a verdict, not an exception', () => {
  const throwingRouteStep = { asset: 'ATOM', side: 'buy', qty: 1, price: 10, notional: 10 };
  Object.defineProperty(throwingRouteStep, 'route', {
    get() { throw new Error('hostile route accessor'); }, enumerable: true,
  });
  assert.doesNotThrow(() => {
    audit(inputWith(baseProposal([throwingRouteStep])), { tailFloorPct: 0.5 });
  }, 'a throwing own route accessor must not throw out of audit()');

  // A real route makes the reachability detail line read proposal.substrate.
  const routedStep = {
    asset: 'ATOM', side: 'buy', qty: 1, price: 10, notional: 10,
    route: { place: 'pool', substrate: 'evm', needs_internal_detail: [] },
  };
  const proposal = baseProposal([routedStep]);
  Object.defineProperty(proposal, 'substrate', {
    get() { throw new Error('hostile substrate accessor'); }, enumerable: true,
  });
  let verdict;
  assert.doesNotThrow(() => {
    verdict = audit(inputWith(proposal), { tailFloorPct: 0.5 });
  }, 'a throwing own substrate accessor must not throw out of audit()');
  assert.equal(invariant(verdict, 'place-route-reachability').pass, true);
});

// ----- M4: oracleReadings staleness reads the fail-closed way -----

test('M4: a non-array or [null] oracleReadings owes a verdict, not a TypeError', () => {
  for (const bad of [{ length: 2 }, [null], 'nope', 42]) {
    assert.doesNotThrow(() => {
      audit(inputWith(baseProposal([]), { oracleReadings: bad, currentTick: 0 }), {});
    }, `a ${JSON.stringify(bad)} oracleReadings must return a verdict, not throw`);
  }
  // [null] with a present clock is unmeasurable per reading → fails closed.
  const nullElem = audit(inputWith(baseProposal([]), { oracleReadings: [null], currentTick: 0 }), {});
  assert.equal(invariant(nullElem, 'pricing-freshness').pass, false);
});

test('M4: a non-numeric observedAtTick or absent currentTick fails freshness closed', () => {
  // Was a NaN-comparison fail-open recording pass: true (a false attestation).
  const badTick = audit(
    inputWith(baseProposal([]), { oracleReadings: [{ observedAtTick: 'soon' }], currentTick: 0 }),
    {},
  );
  assert.equal(invariant(badTick, 'pricing-freshness').pass, false, 'a non-numeric observed tick is stale, not fresh');

  const noClock = audit(
    inputWith(baseProposal([]), { oracleReadings: [{ observedAtTick: 0 }], currentTick: undefined }),
    {},
  );
  const fresh = invariant(noClock, 'pricing-freshness');
  assert.equal(fresh.pass, false, 'an absent current tick under cited readings fails closed');
  assert.match(fresh.detail, /current tick/);
});

// ----- M5: `asset` is type-checked before it keys the balances map -----

test('M5: asset "__proto__" keys a null-prototype slot, so the concentration cap still trips', () => {
  const step = { asset: '__proto__', side: 'buy', qty: 8, price: 10, notional: 80 };
  const verdict = audit(
    inputWith(baseProposal([step]), { prices: { ATOM: 10 } }),
    { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 0.5 },
  );
  const risk = invariant(verdict, 'risk-bound-compliance');
  assert.equal(risk.pass, false, "'__proto__' no longer resolves the balance to Object.prototype (NaN weight)");
  assert.match(risk.detail, /concentration cap/);
  assert.equal(verdict.verdict, 'rejected');
});

test('M5: an asset whose toString throws owes a verdict, not an exception', () => {
  const step = {
    asset: { toString() { throw new Error('hostile asset key'); } },
    side: 'buy', qty: 1, price: 10, notional: 10,
  };
  let verdict;
  assert.doesNotThrow(() => {
    verdict = audit(inputWith(baseProposal([step])), { tailFloorPct: 0.5 });
  }, 'a throwing asset key must not throw out of audit() at balances[asset]');
  assert.equal(invariant(verdict, 'risk-bound-compliance').pass, false);
  assert.equal(verdict.verdict, 'rejected');
});

// ----- M6: Array.isArray guarded against a revoked Proxy -----

test('M6: a revoked-Proxy steps / cited_forecasts owes a verdict, not a TypeError', () => {
  for (const field of ['steps', 'cited_forecasts']) {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    const proposal = { ...baseProposal([]), [field]: proxy };
    let verdict;
    assert.doesNotThrow(() => {
      verdict = audit(inputWith(proposal), {});
    }, `a revoked-Proxy ${field} must return a verdict, not throw on IsArray`);
    assert.equal(verdict.verdict, 'rejected');
  }
});
