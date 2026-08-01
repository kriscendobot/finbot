import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitForecastWorld, worstAssetPersistence } from '../forecaster.js';

// Regressions for the PR #6 round-3 panel's forecaster must-fix bundle. Each
// test reddens if the guard it pins is reverted:
//
//   M5  an object-valued stats().model/selection leaves no mutable leaf in the
//       shallowly-frozen per-asset fit record (type-checked to strings).
//   3b  worstAssetPersistence walks own property NAMES, so a non-enumerable worst
//       asset cannot hide from the enumerability-blind persistence read.

test('M5: an object-valued stats() selection/model leaves no mutable leaf in the frozen fit', () => {
  const feed = { withVolSurface(surface) { return { ...feed, surface }; } };
  const world = { priceFeed: feed };
  const readings = [{ t: 0, prices: { ATOM: 10 } }, { t: 1, prices: { ATOM: 10.5 } }];
  const mutableLeaf = { hostile: true };
  // makeVolSurface passes a caller-supplied surface object through untouched (it
  // carries nextVariance), so a hostile stats() can return OBJECT-valued labels.
  const hostileSurface = {
    nextVariance() { return 0.01; },
    has() { return true; },
    stats() {
      return { unconditionalVol: 0.1, sigma0: 0.1, persistence: 0.9, model: mutableLeaf, selection: mutableLeaf };
    },
  };
  const { fit } = fitForecastWorld(world, readings, hostileSurface);
  const record = fit.assets.ATOM;
  assert.ok(Object.isFrozen(record), 'the per-asset record is frozen');
  assert.notEqual(record.selection, mutableLeaf, 'the object-valued selection was not aliased in');
  assert.notEqual(record.model, mutableLeaf, 'the object-valued model was not aliased in');
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(typeof value, 'object', `no mutable object leaf survives (${key})`);
  }
});

test('3b spec-keeper: a non-enumerable worst asset is still found', () => {
  const assets = { ATOM: { persistence: 0.5 } };
  // The worst (most persistent) asset hidden behind a non-enumerable descriptor.
  Object.defineProperty(assets, 'OSMO', { value: { persistence: 0.99 }, enumerable: false });
  const { worstAsset, persistence } = worstAssetPersistence({ assets });
  assert.equal(worstAsset, 'OSMO', 'the enumerability-blind value read must be matched by the key walk');
  assert.equal(persistence, 0.99);
});
