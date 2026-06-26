/**
 * Per-user volatility-tolerance profile: shape, (de)serialization, and a
 * filesystem-backed store.
 *
 * A profile is the durable output of an elicitation session — the posterior
 * `tau`, its confidence band, the provenance of each contributing signal, when
 * it was elicited, and when it falls due for re-calibration. The planner reads
 * a profile to drive its risk/reward optimization (see `@finbot/pipeline`
 * `profile-allocation.js`).
 *
 * The shaping (`makeVolatilityProfile`) and codec (`serializeProfile` /
 * `parseProfile`) are pure. The only impurity is `ProfileStore`, which reads
 * and writes JSON files under a base directory; its clock is injected so a
 * test can pin `elicitedAt` / `recalibrateAfter` deterministically.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CADENCE_MS } from './elicitation.js';

export const PROFILE_VERSION = 1;

/**
 * Build a profile from a reconciled posterior and the signals behind it.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {{tau: number, sigma: number, lo: number, hi: number, z: number}} input.posterior  reconcileSignals() output
 * @param {Array<{source: string, tau: number, sigma: number}>} [input.signals]  provenance
 * @param {number} input.now            epoch ms the elicitation completed (injected)
 * @param {number} [input.cadenceMs]    re-calibration cadence (default 90 days)
 * @param {object} [input.meta]         free-form extras (interaction id, notes)
 * @returns {object}                    a profile ready to persist
 */
export function makeVolatilityProfile(input) {
  const cadenceMs = input.cadenceMs != null ? input.cadenceMs : DEFAULT_CADENCE_MS;
  const p = input.posterior;
  return {
    version: PROFILE_VERSION,
    userId: input.userId,
    tau: p.tau,
    confidence: {
      lo: p.lo,
      hi: p.hi,
      sigma: p.sigma,
      z: p.z,
    },
    signals: (input.signals || []).map((s) => ({
      source: s.source,
      tau: s.tau,
      sigma: s.sigma,
    })),
    elicitedAt: input.now,
    cadenceMs,
    recalibrateAfter: input.now + cadenceMs,
    meta: input.meta || {},
  };
}

/**
 * Serialize a profile to a stable, pretty JSON string.
 *
 * @param {object} profile
 * @returns {string}
 */
export function serializeProfile(profile) {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

/**
 * Parse and validate a serialized profile.
 *
 * @param {string} text
 * @returns {object}
 * @throws {Error} on malformed JSON or a missing required field
 */
export function parseProfile(text) {
  const obj = JSON.parse(text);
  if (obj == null || typeof obj !== 'object') throw new Error('profile: not an object');
  if (typeof obj.userId !== 'string' || obj.userId === '') throw new Error('profile: missing userId');
  if (!Number.isFinite(obj.tau)) throw new Error('profile: missing/invalid tau');
  if (!obj.confidence || !Number.isFinite(obj.confidence.sigma)) {
    throw new Error('profile: missing confidence band');
  }
  return obj;
}

/** Map a userId to a safe single-path-segment filename. */
function profileFilename(userId) {
  const safe = String(userId).replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === '' || safe === '.' || safe === '..') throw new Error(`unusable userId: ${userId}`);
  return `${safe}.json`;
}

/**
 * A filesystem-backed profile store: one JSON file per user under `baseDir`.
 */
export class ProfileStore {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir          directory to hold per-user profile files
   * @param {() => number} [opts.clock]    epoch-ms clock (default Date.now); injected for determinism
   */
  constructor(opts) {
    if (!opts || !opts.baseDir) throw new Error('ProfileStore requires { baseDir }');
    this.baseDir = opts.baseDir;
    this.clock = opts.clock || (() => Date.now());
  }

  /** Absolute path of a user's profile file. */
  pathFor(userId) {
    return path.join(this.baseDir, profileFilename(userId));
  }

  /** Persist a profile (creating the base directory if needed). */
  save(profile) {
    parseProfile(serializeProfile(profile)); // validate before writing
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.pathFor(profile.userId), serializeProfile(profile));
    return profile;
  }

  /**
   * Load a user's profile, or null if none is stored.
   *
   * @param {string} userId
   * @returns {object | null}
   */
  load(userId) {
    let text;
    try {
      text = fs.readFileSync(this.pathFor(userId), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    return parseProfile(text);
  }

  /** Whether a profile exists for the user. */
  has(userId) {
    return fs.existsSync(this.pathFor(userId));
  }

  /** List the userIds with a stored profile. */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.baseDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return parseProfile(fs.readFileSync(path.join(this.baseDir, f), 'utf8')).userId;
        } catch {
          return null;
        }
      })
      .filter((u) => u != null);
  }

  /** Delete a user's profile; returns true if one was removed. */
  remove(userId) {
    try {
      fs.unlinkSync(this.pathFor(userId));
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
  }
}
