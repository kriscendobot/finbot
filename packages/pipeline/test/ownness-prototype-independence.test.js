import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDataSufficiency, worstAssetPersistence } from '../forecaster.js';

// Both the producing side (`hasOwnPositivePrice`) and the consuming side
// (`readOwn`) read an untrusted property through its own DESCRIPTOR rather than
// with a plain `[[Get]]`, so a hostile accessor cannot run inside `project()` or
// `audit()`. Each then asks that descriptor whether it carries a `value`, and
// THAT question is the subject of this file: a descriptor object is an ordinary
// object inheriting from `Object.prototype`, and `'value' in descriptor` is
// HasProperty, which walks the chain. An ACCESSOR descriptor carries no own
// `value`, so one polluted `Object.prototype.value` answered for every one of
// them — reintroducing, inside the ownness check itself, exactly the
// substitution the descriptor read exists to refuse. `Object.hasOwn` is the
// prototype-independent form of the question.
//
// This file imports ONLY `../forecaster.js`, and that is load-bearing rather
// than incidental. `../auditor.js` reaches `cap-attenuation.js` transitively
// (auditor -> substrates -> cap-attenuation), whose import calls `lockdown()`
// and freezes `Object.prototype`, so the pollution cannot even be staged in a
// process that has imported it — the auditor's half of this hazard is shielded
// today by an import chain that has nothing to do with the gate, which is a
// reason to fix the check and not a reason to trust it. `../forecaster.js`
// pulls in no such chain, so the producing side is exposed in an ordinary
// process and the attack below is a live one, not a hypothetical.
//
// The auditor's own accessor-descriptor behaviour (an accessor `p05Equity` /
// `dataSufficiency` reads as ABSENT and fails the armed gate closed) is pinned
// in `auditor-data-sufficiency.test.js`, which can assert it under lockdown.

/** Stage the pollution, run the probe, and always clean up. */
function withPollutedValue(value, probe) {
  assert.ok(
    Object.isExtensible(Object.prototype),
    'this file must not import a module that calls lockdown(), or the attack cannot be staged',
  );
  Object.prototype.value = value; // eslint-disable-line no-extend-native
  try {
    return probe();
  } finally {
    delete Object.prototype.value;
  }
}

test('forecaster: a polluted Object.prototype.value supplies no price', () => {
  // Three frames whose ATOM price is an ACCESSOR — no own `value` on the
  // descriptor — so the honest measurement is zero observations. Polluted, an
  // `in`-based check reads 42 as the price on every frame and the descriptor
  // reports full coverage: enough to clear an armed `dataSufficiencyMinCoverage:
  // 1`, so the gate flips from reject to approve on a single prototype write.
  const frames = Array.from({ length: 3 }, () => Object.defineProperty(
    {}, 'ATOM', { get: () => 0, enumerable: true },
  ));
  const clean = computeDataSufficiency({ frames, horizon: 2, assets: ['ATOM'] });
  assert.equal(clean.coverageRatio, 0);
  assert.equal(clean.historyFrames, 0);

  const polluted = withPollutedValue(
    42,
    () => computeDataSufficiency({ frames, horizon: 2, assets: ['ATOM'] }),
  );
  assert.deepEqual(polluted, clean, 'the polluted prototype changed nothing');
});

test('forecaster: a polluted Object.prototype.value supplies no regime persistence', () => {
  // `readOwnDataProperty` is the same descriptor+`hasOwn(_, 'value')` question the
  // frame-price read asks, and `worstAssetPersistence` uses it to read
  // `volFit.assets[asset].persistence` — the value that keys the regime tail floor
  // and horizon stretch. An ACCESSOR persistence carries no own `value`, so the
  // honest read finds no regime; an `in`-based check would let one polluted
  // `Object.prototype.value` name a worst asset at the polluted persistence and
  // MOVE the floor the auditor enforces. This pins the second reader, not only
  // `hasOwnPositivePrice`.
  const volFit = {
    assets: { ATOM: Object.defineProperty({}, 'persistence', { get: () => 0.99, enumerable: true }) },
  };
  const clean = worstAssetPersistence(volFit);
  assert.deepEqual(clean, { worstAsset: null, persistence: 0 });

  const polluted = withPollutedValue(0.99, () => worstAssetPersistence(volFit));
  assert.deepEqual(polluted, clean, 'the polluted prototype named no regime');
});

test('forecaster: an own DATA persistence is still read as a regime', () => {
  const volFit = { assets: { ATOM: { persistence: 0.95 } } };
  const expected = worstAssetPersistence(volFit);
  assert.deepEqual(expected, { worstAsset: 'ATOM', persistence: 0.95 });

  const polluted = withPollutedValue(0.1, () => worstAssetPersistence(volFit));
  assert.deepEqual(polluted, expected, 'the honest own-data regime still reads');
});

test('forecaster: an own DATA property is still read — the guard narrowed nothing real', () => {
  // The counterpart assertion: tightening the ownness check must not stop the
  // honest path from reading honest evidence, polluted prototype or not.
  const frames = [{ ATOM: 1 }, { ATOM: 2 }, { ATOM: 3 }];
  const expected = computeDataSufficiency({ frames, horizon: 2, assets: ['ATOM'] });
  assert.equal(expected.coverageRatio, 1);
  assert.equal(expected.historyFrames, 3);

  const polluted = withPollutedValue(
    999,
    () => computeDataSufficiency({ frames, horizon: 2, assets: ['ATOM'] }),
  );
  assert.deepEqual(polluted, expected);
});
