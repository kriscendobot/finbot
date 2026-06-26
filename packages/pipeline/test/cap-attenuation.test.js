import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityError, CAPABILITY_MAP, LIVE_ONLY_CAPS,
  makeWalletCapability, attenuateForRole, runInAttenuatedCompartment,
} from '../cap-attenuation.js';

// A FAKE in-memory signer — no keys, no funds, no network. Exists only to
// prove the attenuation boundary; never a real wallet (per the job's hard
// safety bound).
function fakeSigner() {
  return {
    address: () => 'sim1faketestaddr',
    sign: (tx) => ({ signed: true, tx }),
    submit: () => { throw new Error('fake signer never submits'); },
  };
}

test('the capability map confines wallet/signing-rpc to the executor', () => {
  for (const [role, entry] of Object.entries(CAPABILITY_MAP)) {
    const hasWallet = entry.vended.includes('wallet');
    assert.equal(hasWallet, role === 'executor', `${role} wallet vending`);
  }
  assert.ok(LIVE_ONLY_CAPS.has('wallet'));
  assert.ok(LIVE_ONLY_CAPS.has('signing-rpc'));
});

test('dry-run executor is NOT vended the wallet', () => {
  const { cap } = makeWalletCapability(fakeSigner());
  const caps = attenuateForRole('executor', { wallet: cap, 'signing-rpc': {} }, { live: false });
  assert.equal(caps.wallet, undefined);
  assert.equal(caps['signing-rpc'], undefined);
});

test('live executor IS vended the wallet', () => {
  const { cap } = makeWalletCapability(fakeSigner());
  const caps = attenuateForRole('executor', { wallet: cap, 'signing-rpc': { url: 'x' } }, { live: true });
  assert.equal(caps.wallet, cap);
  assert.deepEqual(caps['signing-rpc'], { url: 'x' });
});

test('no non-executor role is ever vended the wallet, even live', () => {
  const { cap } = makeWalletCapability(fakeSigner());
  for (const role of ['planner', 'auditor', 'analyzer', 'forecaster', 'oracle-watcher', 'monitor', 'journalist']) {
    const caps = attenuateForRole(role, { wallet: cap }, { live: true });
    assert.equal(caps.wallet, undefined, `${role} must never see the wallet`);
  }
});

test('the wallet capability is interface-guarded (only whitelisted methods)', () => {
  const { cap } = makeWalletCapability(fakeSigner(), ['address', 'sign']);
  assert.equal(cap.address(), 'sim1faketestaddr');
  assert.deepEqual(cap.sign({ a: 1 }), { signed: true, tx: { a: 1 } });
  assert.equal(cap.submit, undefined, 'submit was not whitelisted');
});

test('revoke makes the wallet fail closed', () => {
  const { cap, revoke } = makeWalletCapability(fakeSigner());
  assert.equal(cap.address(), 'sim1faketestaddr');
  revoke();
  assert.throws(() => cap.address(), CapabilityError);
});

test('runInAttenuatedCompartment drops the wallet after the call', async () => {
  const { cap, revoke } = makeWalletCapability(fakeSigner());
  let sawWallet;
  await runInAttenuatedCompartment({
    role: 'executor',
    parentCaps: { wallet: cap },
    live: true,
    walletRevoke: revoke,
    fn: (caps) => { sawWallet = caps.wallet; assert.equal(caps.wallet.address(), 'sim1faketestaddr'); },
  });
  assert.ok(sawWallet, 'executor saw the wallet during the call');
  // After the compartment returns, the vended ref is revoked.
  assert.throws(() => sawWallet.address(), CapabilityError);
});

test('runInAttenuatedCompartment revokes even when fn throws', async () => {
  const { cap, revoke } = makeWalletCapability(fakeSigner());
  let leaked;
  await assert.rejects(runInAttenuatedCompartment({
    role: 'executor',
    parentCaps: { wallet: cap },
    live: true,
    walletRevoke: revoke,
    fn: (caps) => { leaked = caps.wallet; throw new Error('boom'); },
  }), /boom/);
  assert.throws(() => leaked.address(), CapabilityError);
});

test('attenuateForRole rejects an unknown role', () => {
  assert.throws(() => attenuateForRole('nope', {}), CapabilityError);
});
