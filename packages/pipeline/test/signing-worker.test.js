import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectSigningWorkerInProcess,
  makeSigningWorkerBootstrap,
  spawnSigningWorker,
} from '../signing-worker.js';
import { CapabilityError } from '../cap-attenuation.js';

// FAKE in-memory signer — no keys, no funds, no network. The whole point is to
// prove the CapTP boundary without ever touching a real wallet.
function fakeSigner() {
  let nonce = 0;
  return {
    address: () => 'sim1faketestaddr',
    sign: (tx) => ({ signed: true, nonce: (nonce += 1), tx }),
    submit: () => { throw new Error('fake signer never submits'); },
  };
}

test('the executor operates the wallet purely as a remote CapTP presence', async () => {
  const { wallet, E, teardown } = connectSigningWorkerInProcess({
    backing: fakeSigner(), methods: ['address', 'sign'],
  });
  try {
    // The executor never holds the backing signer — only a presence it must E().
    const addr = await E(wallet).address();
    assert.equal(addr, 'sim1faketestaddr');
    const signed = await E(wallet).sign({ amount: 5 });
    assert.equal(signed.signed, true);
    assert.deepEqual(signed.tx, { amount: 5 });
  } finally {
    teardown();
  }
});

test('the worker-side InterfaceGuard confines the remote wallet to whitelisted methods', async () => {
  const { wallet, E, teardown } = connectSigningWorkerInProcess({
    backing: fakeSigner(), methods: ['address', 'sign'], // submit NOT whitelisted
  });
  try {
    await assert.rejects(E(wallet).submit(), /.+/, 'off-interface method is rejected across the boundary');
  } finally {
    teardown();
  }
});

test('teardown revokes the worker-side wallet (fail closed after the dispatch)', async () => {
  const { wallet, E, teardown } = connectSigningWorkerInProcess({
    backing: fakeSigner(), methods: ['address'],
  });
  assert.equal(await E(wallet).address(), 'sim1faketestaddr');
  teardown();
  await assert.rejects(E(wallet).address(), /.+/, 'a presence retained past teardown is inert');
});

test('makeSigningWorkerBootstrap holds the backing signer and exposes only the Exo', () => {
  const { bootstrap, revoke } = makeSigningWorkerBootstrap(fakeSigner(), ['address', 'sign']);
  assert.equal(typeof bootstrap.address, 'function');
  assert.equal(bootstrap.submit, undefined, 'submit not in the interface guard');
  assert.equal(typeof revoke, 'function');
});

test('spawnSigningWorker is gated: it refuses without live authorization', () => {
  assert.throws(() => spawnSigningWorker({}), CapabilityError);
  assert.throws(() => spawnSigningWorker({ live_authorized: true }), CapabilityError, 'needs a keystore too');
  // Even fully authorized, the cross-process transport is a deferred open
  // question — it refuses rather than commit to an unchosen transport.
  assert.throws(
    () => spawnSigningWorker({ live_authorized: true, keystorePath: '/nonexistent/keystore' }),
    /transport not yet chosen/,
  );
});
