/**
 * Capability attenuation — the wallet boundary, on real SES compartments.
 *
 * `designs/cap-attenuation.md` describes the end-state: each role's code runs
 * in an SES Compartment with an explicit globals/modules policy built from the
 * capability map, and each cross-compartment capability is vended as an
 * `@endo/exo` Far ref behind an InterfaceGuard. The wallet Far exists only in
 * the executor's compartment, only in `--live` mode, only for the duration of
 * the dispatch, and the outside reference is dropped on return.
 *
 * This module is the v1 attenuator: it pulls in SES + `@endo/exo` so the
 * boundary is enforced by the runtime, not by convention.
 *
 *   - `CAPABILITY_MAP` keys, per role, the ambient globals the role's code may
 *     name and the cross-compartment caps it may be vended. `attenuateForRole`
 *     filters a parent cap bag down to the vended subset; `wallet`/`signing-rpc`
 *     are additionally gated on `live === true`, so the executor in dry-run, and
 *     every other role in any mode, gets no wallet at all.
 *   - `makeRoleCompartment` / `evaluateInRoleCompartment` run a role's code in a
 *     real `Compartment` whose `globalThis` is exactly the role's ambient policy
 *     plus its vended caps. Ambient authority is the empty set: a forecaster's
 *     code cannot name `process`, `fetch`, `require`, or `Math.random` — nor
 *     reach them through `Function("…")()` — unless its policy granted them.
 *   - `makeWalletCapability` vends the wallet as an `@endo/exo` Far behind an
 *     `InterfaceGuard` (only whitelisted methods are callable; the guard rejects
 *     off-interface calls at the boundary), fronted by a revocable forwarder so
 *     a reference retained past the dispatch fails closed.
 *
 * A buggy or captured role that tries to reach the wallet trips a
 * `CapabilityError` (the cap is simply absent from its attenuated set) or the
 * InterfaceGuard — not the chain. Safety moves from "the LLM follows the prompt"
 * to "the runtime cannot reach the wallet unless it was vended".
 *
 * SES note: importing this module calls `lockdown()` once for the process
 * (idempotent and guarded), hardening the shared intrinsics so a compartment
 * cannot reach the host realm by mutating a prototype it shares. `@endo/exo`
 * and `@endo/patterns` are imported *after* lockdown, per Endo's convention
 * (they bind the SES-provided `harden`).
 */

import 'ses';
import '@endo/eventual-send/shim.js';

// lockdown() must run once before any compartment is built or any Exo is made,
// and it throws if run twice — so guard on an observable post-lockdown fact
// (the shared intrinsics are frozen) and swallow the redundant-call error if a
// peer module locked down first.
function ensureLockdown() {
  if (Object.isFrozen(Object.prototype)) return;
  try {
    lockdown({ errorTaming: 'unsafe', overrideTaming: 'severe' });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!/locked down|repairIntrinsics/i.test(message)) throw err;
  }
}
ensureLockdown();

// Imported after lockdown: exo/patterns bind the SES `harden`, so importing
// them before lockdown installs a foreign harden and makes lockdown refuse.
const { makeExo } = await import('@endo/exo');
const { M } = await import('@endo/patterns');

export class CapabilityError extends Error {}

/**
 * The capability map (mirrors `designs/cap-attenuation.md` § Capability map).
 * `ambient` is the role's globals policy (see `buildRolePolicy`); `vended` is
 * the set of cross-compartment cap names the role may be handed. `wallet` and
 * `signing-rpc` are special-cased to also require `live`.
 */
export const CAPABILITY_MAP = {
  liaison: { ambient: 'full', vended: [] },
  steward: { ambient: 'bounded', vended: [] },
  'oracle-watcher': { ambient: 'fetch,console', vended: [] },
  monitor: { ambient: 'console', vended: ['rpc-read'] },
  forecaster: { ambient: 'console,rng', vended: [] },
  analyzer: { ambient: 'console', vended: ['forecaster-results', 'monitor-results'] },
  planner: { ambient: 'console', vended: ['analyzer-results', 'forecasts', 'rpc-read'] },
  auditor: { ambient: 'console', vended: ['rpc-read', 'planner-result'] },
  executor: { ambient: 'console', vended: ['rpc-read', 'wallet', 'signing-rpc'] },
  journalist: { ambient: 'console', vended: ['journal-read'] },
};

/** Capability names that require `--live` authorization to be vended at all. */
export const LIVE_ONLY_CAPS = new Set(['wallet', 'signing-rpc']);

/**
 * Deterministic, seeded PRNG (mulberry32). The forecaster's `rng` ambient is a
 * *seeded* RNG, never the host's `Math.random` (which lockdown denies inside a
 * compartment precisely so nondeterminism cannot leak in ungoverned). The seed
 * makes a forecaster run reproducible.
 *
 * @param {number} seed
 * @returns {() => number} a function returning floats in [0, 1)
 */
export function makeSeededRandom(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the ambient globals a role's compartment is allowed to name, from its
 * `ambient` policy string. Ambient authority is the empty set by default: a
 * token grants exactly one named global and nothing else. An unknown token is
 * an error rather than a silent grant.
 *
 * Tokens: `console` (the host console), `fetch` (the host fetch), `rng` (a
 * seeded `random` global; see `makeSeededRandom`), `full`/`bounded` (the
 * orchestrator surfaces — `console` + `fetch`; the orchestrator itself is not
 * sandboxed, so this is the surface its in-compartment helpers may name).
 *
 * @param {string} role
 * @param {object} [opts]
 * @param {number} [opts.seed]   seed for the `rng` token's seeded random
 * @returns {Record<string, unknown>}  a globals map (not yet hardened)
 */
export function buildRolePolicy(role, opts = {}) {
  const entry = CAPABILITY_MAP[role];
  if (!entry) throw new CapabilityError(`unknown role for attenuation: ${role}`);
  const globals = {};
  const grant = (token) => {
    switch (token) {
      case 'console':
        globals.console = console;
        break;
      case 'fetch':
        if (typeof fetch === 'function') globals.fetch = fetch;
        break;
      case 'rng':
        globals.random = makeSeededRandom(opts.seed);
        break;
      case 'full':
      case 'bounded':
        // orchestrator surfaces: the broad-but-explicit set its helpers may name
        globals.console = console;
        if (typeof fetch === 'function') globals.fetch = fetch;
        break;
      default:
        throw new CapabilityError(`unknown ambient token for role ${role}: ${token}`);
    }
  };
  for (const token of entry.ambient.split(',')) grant(token.trim());
  return globals;
}

/**
 * Build an interface-guarded, revocable wallet capability.
 *
 * The real authority is an `@endo/exo` Far behind an `InterfaceGuard`: only the
 * whitelisted methods exist, and the guard validates each call at the boundary.
 * In front of it sits a revocable forwarder (the classic caretaker pattern):
 * after `revoke()` every method throws `CapabilityError`, so a reference
 * retained past the dispatch is inert. The forwarder, not the raw Exo, is what
 * gets vended — revocation is a lifecycle concern orthogonal to the guard.
 *
 * In dry-run this is never constructed — the executor proves it by asserting
 * the wallet cap is absent from its attenuated set.
 *
 * @param {object} backing   the real signer (only ever built in --live from an out-of-tree keystore)
 * @param {string[]} [methods]  whitelisted method names (default: address, sign, submit)
 * @returns {{ cap: object, exo: object, revoke: () => void }}
 */
export function makeWalletCapability(backing, methods = ['address', 'sign', 'submit']) {
  // Dynamic InterfaceGuard over exactly the whitelisted methods. Args/returns
  // are left permissive (M.any) — the guard's job here is the method whitelist
  // and the cross-boundary hardening, not argument schemas.
  const guards = {};
  for (const m of methods) {
    guards[m] = M.call().rest(M.any()).returns(M.any());
  }
  const iface = M.interface('Wallet', guards);

  const behavior = {};
  for (const m of methods) {
    behavior[m] = (...args) => {
      if (typeof backing[m] !== 'function') {
        throw new CapabilityError(`wallet method not in interface guard: ${m}`);
      }
      return backing[m](...args);
    };
  }
  const exo = makeExo('Wallet', iface, behavior);

  // Revocable forwarder. Errors thrown across an Exo membrane are flattened to
  // generic passed errors, so the revoke gate lives here, in front of the Exo,
  // where it can throw a real CapabilityError.
  let revoked = false;
  const cap = {};
  for (const m of methods) {
    cap[m] = (...args) => {
      if (revoked) throw new CapabilityError('wallet capability revoked');
      return exo[m](...args);
    };
  }
  Object.freeze(cap);
  return { cap, exo, revoke: () => { revoked = true; } };
}

/**
 * Attenuate a parent capability bag down to the subset a role may see.
 *
 * @param {string} role
 * @param {Record<string, unknown>} parentCaps   every capability the orchestrator holds
 * @param {object} [opts]
 * @param {boolean} [opts.live]   whether this is a live (authorized) dispatch; default false
 * @returns {Record<string, unknown>}  frozen attenuated cap set (only allowed names present)
 */
export function attenuateForRole(role, parentCaps = {}, opts = {}) {
  const entry = CAPABILITY_MAP[role];
  if (!entry) throw new CapabilityError(`unknown role for attenuation: ${role}`);
  const live = opts.live === true;
  const out = {};
  for (const name of entry.vended) {
    if (LIVE_ONLY_CAPS.has(name) && !live) continue; // wallet/signing-rpc gated on live
    if (parentCaps[name] !== undefined) out[name] = parentCaps[name];
  }
  return Object.freeze(out);
}

/**
 * Build the SES Compartment a role's code runs in. Its `globalThis` is exactly
 * the role's ambient policy (`buildRolePolicy`) plus its attenuated vended caps
 * (`attenuateForRole`) — nothing else. Ambient authority is the empty set: code
 * evaluated in this compartment cannot name any host global the policy did not
 * grant, and cannot reach one through `Function`/`eval` (those evaluators bind
 * the compartment's `globalThis`, not the host realm's).
 *
 * @param {object} args
 * @param {string} args.role
 * @param {Record<string, unknown>} [args.endowments]   parent caps to attenuate + vend as globals
 * @param {boolean} [args.live]
 * @param {number} [args.seed]   seed for a forecaster-style `rng` ambient
 * @returns {Compartment}
 */
export function makeRoleCompartment(args) {
  const { role, endowments = {}, live, seed } = args;
  const policy = buildRolePolicy(role, { seed });
  const caps = attenuateForRole(role, endowments, { live });
  const globals = { ...policy };
  for (const [name, value] of Object.entries(caps)) globals[name] = value;
  return new Compartment({ globals: harden(globals), __options__: true, name: `role:${role}` });
}

/**
 * Evaluate `source` (a string of role code) inside the role's compartment and
 * return its completion value. This is the genuinely-sandboxed path: `source`
 * is untrusted and runs with only the role's granted authority.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {string} args.source
 * @param {Record<string, unknown>} [args.endowments]
 * @param {boolean} [args.live]
 * @param {number} [args.seed]
 * @returns {any}
 */
export function evaluateInRoleCompartment(args) {
  const compartment = makeRoleCompartment(args);
  return compartment.evaluate(args.source);
}

/**
 * Run `fn` with the role's attenuated capability set, then drop any vended
 * wallet so it cannot be re-invoked after the call returns. This is the
 * in-process analog of "the compartment is discarded; the wallet reference
 * becomes unreachable" from the design.
 *
 * This is the host-trusted executor path: `fn` is a host closure (e.g. the
 * dry-run simulator), so it runs in-process rather than as compartment-evaluated
 * source — the sandbox value for untrusted code is `evaluateInRoleCompartment`.
 * The boundary `fn` is held to is the attenuated cap set: in dry-run the wallet
 * is absent, and `walletRevoke` severs the vended wallet in a `finally` so even
 * a throwing `fn` drops the authority.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {Record<string, unknown>} args.parentCaps
 * @param {boolean} [args.live]
 * @param {(() => void)} [args.walletRevoke]
 * @param {(caps: Record<string, unknown>) => Promise<any> | any} args.fn
 * @returns {Promise<any>}
 */
export async function runInAttenuatedCompartment(args) {
  const caps = attenuateForRole(args.role, args.parentCaps, { live: args.live });
  try {
    return await args.fn(caps);
  } finally {
    if (typeof args.walletRevoke === 'function') args.walletRevoke();
  }
}
