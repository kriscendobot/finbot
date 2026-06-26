import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityError,
  buildRolePolicy,
  makeRoleCompartment,
  evaluateInRoleCompartment,
  makeWalletCapability,
  makeSeededRandom,
} from '../cap-attenuation.js';

// Importing cap-attenuation.js has already called lockdown(); pass-style binds
// the SES `harden`, so it is safe to import here for the Far-ness assertion.
const { passStyleOf } = await import('@endo/pass-style');

// A FAKE in-memory signer — no keys, no funds, no network. Exists only to
// prove the boundary; never a real wallet (per the job's hard safety bound).
function fakeSigner() {
  return {
    address: () => 'sim1faketestaddr',
    sign: (tx) => ({ signed: true, tx }),
    submit: () => { throw new Error('fake signer never submits'); },
  };
}

// ---------------------------------------------------------------------------
// Ambient-authority denial: a role's compartment cannot name a host global
// its policy did not grant, and cannot reach one through Function/eval.
// ---------------------------------------------------------------------------

test('a forecaster compartment cannot reach the filesystem, network, or process', () => {
  for (const probe of ['typeof process', 'typeof require', 'typeof globalThis.process']) {
    assert.equal(
      evaluateInRoleCompartment({ role: 'forecaster', source: probe }),
      'undefined',
      `forecaster must not name host authority via \`${probe}\``,
    );
  }
});

test('a forecaster compartment is not granted fetch (network) by its policy', () => {
  assert.equal(evaluateInRoleCompartment({ role: 'forecaster', source: 'typeof fetch' }), 'undefined');
});

test('the Function constructor cannot escape the compartment to host authority', () => {
  // Function inside a compartment binds the COMPARTMENT global, not the host
  // realm — so the classic `Function("return this")()` escape reaches only the
  // compartment's (empty) ambient, where `process` is undefined.
  assert.equal(
    evaluateInRoleCompartment({ role: 'forecaster', source: 'Function("return typeof process")()' }),
    'undefined',
  );
  assert.equal(
    evaluateInRoleCompartment({ role: 'forecaster', source: '(function(){ return typeof this; })()' }),
    'undefined',
  );
  // Direct eval is censored outright by SES — an even stronger denial.
  assert.throws(
    () => evaluateInRoleCompartment({ role: 'forecaster', source: 'eval("typeof require")' }),
    /SES_EVAL_REJECTED|eval/,
  );
});

test('ungoverned nondeterminism (Math.random) is denied inside a compartment', () => {
  // lockdown removes Math.random from compartments so a role cannot draw
  // ungoverned randomness; the forecaster instead gets a seeded `random`.
  assert.throws(
    () => evaluateInRoleCompartment({ role: 'forecaster', source: 'Math.random()' }),
    /TypeError|not a function|random/,
  );
});

test('a granted ambient IS reachable: forecaster has seeded rng + console', () => {
  assert.equal(evaluateInRoleCompartment({ role: 'forecaster', source: 'typeof random' }), 'function');
  assert.equal(evaluateInRoleCompartment({ role: 'forecaster', source: 'typeof console' }), 'object');
  // the seeded rng is deterministic and in range
  const draw = evaluateInRoleCompartment({ role: 'forecaster', source: 'random()', seed: 42 });
  assert.ok(draw >= 0 && draw < 1, 'seeded draw in [0,1)');
  assert.equal(
    evaluateInRoleCompartment({ role: 'forecaster', source: 'random()', seed: 42 }),
    draw,
    'same seed -> same first draw (reproducible)',
  );
});

test('oracle-watcher IS granted fetch (its policy lists it) but nothing more', () => {
  assert.equal(evaluateInRoleCompartment({ role: 'oracle-watcher', source: 'typeof fetch' }), 'function');
  assert.equal(evaluateInRoleCompartment({ role: 'oracle-watcher', source: 'typeof process' }), 'undefined');
  // oracle-watcher's policy does NOT grant rng
  assert.equal(evaluateInRoleCompartment({ role: 'oracle-watcher', source: 'typeof random' }), 'undefined');
});

// ---------------------------------------------------------------------------
// Vended caps appear as compartment globals only when attenuation allows them.
// ---------------------------------------------------------------------------

test('the wallet is vended into the live executor compartment, absent in dry-run', () => {
  const { cap } = makeWalletCapability(fakeSigner());
  const liveSees = evaluateInRoleCompartment({
    role: 'executor', source: 'typeof wallet', endowments: { wallet: cap }, live: true,
  });
  assert.equal(liveSees, 'object', 'live executor sees the vended wallet (the revocable forwarder)');
  assert.equal(
    evaluateInRoleCompartment({
      role: 'executor', source: 'wallet.address()', endowments: { wallet: cap }, live: true,
    }),
    'sim1faketestaddr',
    'and can call it through the InterfaceGuard',
  );

  const dryRunSees = evaluateInRoleCompartment({
    role: 'executor', source: 'typeof wallet', endowments: { wallet: cap }, live: false,
  });
  assert.equal(dryRunSees, 'undefined', 'dry-run executor never sees the wallet');
});

test('no non-executor compartment is ever vended the wallet, even live', () => {
  const { cap } = makeWalletCapability(fakeSigner());
  for (const role of ['planner', 'auditor', 'analyzer', 'forecaster', 'monitor', 'journalist']) {
    const sees = evaluateInRoleCompartment({
      role, source: 'typeof globalThis.wallet', endowments: { wallet: cap }, live: true,
    });
    assert.equal(sees, 'undefined', `${role} must never see the wallet`);
  }
});

// ---------------------------------------------------------------------------
// The wallet is a real @endo/exo Far behind an InterfaceGuard.
// ---------------------------------------------------------------------------

test('the wallet is a real Far (passStyleOf === remotable)', () => {
  const { exo } = makeWalletCapability(fakeSigner(), ['address', 'sign']);
  assert.equal(passStyleOf(exo), 'remotable', 'the vended authority is a Far ref');
});

test('the InterfaceGuard confines the wallet to its whitelisted methods', () => {
  const { exo, cap } = makeWalletCapability(fakeSigner(), ['address', 'sign']);
  // off-interface methods simply do not exist on the guarded Far
  assert.equal(exo.submit, undefined, 'submit not in the interface guard');
  assert.equal(cap.submit, undefined, 'submit not on the revocable forwarder');
  // whitelisted methods work through the guard
  assert.equal(exo.address(), 'sim1faketestaddr');
  assert.deepEqual(exo.sign({ a: 1 }), { signed: true, tx: { a: 1 } });
});

// ---------------------------------------------------------------------------
// buildRolePolicy / makeRoleCompartment shape.
// ---------------------------------------------------------------------------

test('buildRolePolicy grants exactly the role’s ambient tokens', () => {
  const forecaster = buildRolePolicy('forecaster', { seed: 7 });
  assert.deepEqual(new Set(Object.keys(forecaster)), new Set(['console', 'random']));
  const executor = buildRolePolicy('executor');
  assert.deepEqual(Object.keys(executor), ['console']);
  const watcher = buildRolePolicy('oracle-watcher');
  assert.deepEqual(new Set(Object.keys(watcher)), new Set(['console', 'fetch']));
});

test('buildRolePolicy rejects an unknown role', () => {
  assert.throws(() => buildRolePolicy('nope'), CapabilityError);
});

test('makeRoleCompartment yields a Compartment whose evaluate runs sandboxed', () => {
  const c = makeRoleCompartment({ role: 'analyzer' });
  assert.equal(typeof c.evaluate, 'function');
  assert.equal(c.evaluate('1 + 1'), 2);
  assert.equal(c.evaluate('typeof process'), 'undefined');
});

test('makeSeededRandom is deterministic for a given seed', () => {
  const a = makeSeededRandom(123);
  const b = makeSeededRandom(123);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
});
