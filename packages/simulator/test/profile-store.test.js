import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reconcileSignals,
  signalFromDrawdown,
  signalFromSlider,
  recalibrationStatus,
  DEFAULT_CADENCE_MS,
} from '../elicitation.js';
import {
  makeVolatilityProfile,
  serializeProfile,
  parseProfile,
  ProfileStore,
  PROFILE_VERSION,
} from '../profile-store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'finbot-profiles-'));
}

const posterior = reconcileSignals([signalFromDrawdown(0.3), signalFromSlider(0.6)]);

test('makeVolatilityProfile: shapes posterior + provenance + cadence', () => {
  const now = 1_700_000_000_000;
  const profile = makeVolatilityProfile({
    userId: 'alice',
    posterior,
    signals: [signalFromDrawdown(0.3), signalFromSlider(0.6)],
    now,
  });
  assert.equal(profile.version, PROFILE_VERSION);
  assert.equal(profile.userId, 'alice');
  assert.equal(profile.tau, posterior.tau);
  assert.equal(profile.confidence.sigma, posterior.sigma);
  assert.equal(profile.elicitedAt, now);
  assert.equal(profile.recalibrateAfter, now + DEFAULT_CADENCE_MS);
  assert.equal(profile.signals.length, 2);
  assert.equal(profile.signals[0].source, 'max-drawdown');
});

test('serialize/parse: round-trips', () => {
  const profile = makeVolatilityProfile({ userId: 'bob', posterior, now: 42 });
  const parsed = parseProfile(serializeProfile(profile));
  assert.deepEqual(parsed, profile);
});

test('parseProfile: rejects malformed profiles', () => {
  assert.throws(() => parseProfile('{ not json'));
  assert.throws(() => parseProfile(JSON.stringify({ tau: 0.5 }))); // no userId
  assert.throws(() => parseProfile(JSON.stringify({ userId: 'x' }))); // no tau
});

test('ProfileStore: save -> load round-trips, missing -> null', () => {
  const baseDir = tmpDir();
  const store = new ProfileStore({ baseDir, clock: () => 99 });
  assert.equal(store.load('carol'), null);
  assert.equal(store.has('carol'), false);

  const profile = makeVolatilityProfile({ userId: 'carol', posterior, now: store.clock() });
  store.save(profile);
  assert.equal(store.has('carol'), true);
  assert.deepEqual(store.load('carol'), profile);
});

test('ProfileStore: list and remove', () => {
  const store = new ProfileStore({ baseDir: tmpDir() });
  store.save(makeVolatilityProfile({ userId: 'u1', posterior, now: 1 }));
  store.save(makeVolatilityProfile({ userId: 'u2', posterior, now: 2 }));
  assert.deepEqual(store.list().sort(), ['u1', 'u2']);
  assert.equal(store.remove('u1'), true);
  assert.equal(store.remove('u1'), false);
  assert.deepEqual(store.list(), ['u2']);
});

test('ProfileStore: a userId with separators cannot escape the base dir', () => {
  const baseDir = tmpDir();
  const store = new ProfileStore({ baseDir });
  const profile = makeVolatilityProfile({ userId: '../../etc/passwd', posterior, now: 1 });
  store.save(profile);
  // The file lands inside baseDir (sanitized), not at a traversed path.
  const files = fs.readdirSync(baseDir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('/'));
  assert.deepEqual(store.load('../../etc/passwd'), profile);
});

test('ProfileStore + recalibration: a stored profile reports when it is due', () => {
  const baseDir = tmpDir();
  const store = new ProfileStore({ baseDir, clock: () => 1000 });
  const profile = makeVolatilityProfile({
    userId: 'dave', posterior, now: store.clock(), cadenceMs: 500,
  });
  store.save(profile);
  const loaded = store.load('dave');
  assert.equal(recalibrationStatus(loaded, 1200).due, false);
  assert.equal(recalibrationStatus(loaded, 1600).due, true);
});
