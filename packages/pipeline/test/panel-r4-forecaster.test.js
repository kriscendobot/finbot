import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDataSufficiency } from '../forecaster.js';

// Regression for the PR #6 round-4 panel's forecaster half of M6: `Array.isArray`
// is not total — it throws a TypeError on a REVOKED Proxy (ECMA-262 §7.2.2 IsArray
// step 3.a) — and `measureHistoryCoverage` / `namedAssets` called it unguarded on
// caller-supplied `frames` / `assets`. A revoked-Proxy input must measure as
// unmeasurable (zero coverage, the fail-closed direction), never throw.

test('M6: computeDataSufficiency treats a revoked-Proxy frames as unmeasurable, not a throw', () => {
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  let descriptor;
  assert.doesNotThrow(() => {
    descriptor = computeDataSufficiency({ frames: proxy, horizon: 5, assets: ['ATOM'] });
  }, 'a revoked-Proxy frames must not throw on IsArray');
  assert.equal(descriptor.historyReturns, 0, 'an unmeasurable window is zero coverage (fails closed)');
});

test('M6: computeDataSufficiency treats a revoked-Proxy assets as unmeasurable, not a throw', () => {
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  let descriptor;
  assert.doesNotThrow(() => {
    descriptor = computeDataSufficiency({ frames: [{ ATOM: 10 }, { ATOM: 11 }], horizon: 5, assets: proxy });
  }, 'a revoked-Proxy assets must not throw on IsArray');
  assert.equal(descriptor.historyReturns, 0, 'no nameable asset measures zero (fails closed)');
});
