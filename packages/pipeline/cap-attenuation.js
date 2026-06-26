/**
 * Capability attenuation — the wallet boundary.
 *
 * `designs/cap-attenuation.md` describes the end-state: each role's code runs
 * in an SES Compartment with an explicit globals/modules policy, and each
 * cross-compartment capability is vended as an `@endo/exo` Far ref behind an
 * InterfaceGuard. The wallet Far exists only in the executor's compartment,
 * only in `--live` mode, only for the duration of the dispatch, and the
 * outside reference is dropped on return.
 *
 * This module is the in-process v0.5 attenuator that enforces the *boundary*
 * that design specifies, without yet pulling in SES/@endo (a deliberately
 * dependency-free step; the SES upgrade is a posted follow-on). It enforces,
 * at runtime and in plain JS:
 *
 *   - a capability MAP keyed by role (the table in the design), so only the
 *     roles a capability is vended to can name it;
 *   - the wallet is attenuated to the executor AND only when `live === true`;
 *     every other role, and the executor in dry-run, gets no wallet at all;
 *   - the vended wallet is an interface-guarded object: only whitelisted
 *     methods are callable, and a `revoke()` drops the underlying authority so
 *     a reference retained past the dispatch fails closed.
 *
 * A buggy or captured role that tries to reach the wallet trips a
 * `CapabilityError` (the cap is simply absent from its attenuated set), not
 * the chain. That is the whole point: safety moves from "the LLM follows the
 * prompt" to "the runtime cannot reach the wallet unless it was vended".
 */

export class CapabilityError extends Error {}

/**
 * The capability map (mirrors `designs/cap-attenuation.md` § Capability map).
 * `ambient` is documentary here (the in-process v0.5 does not yet sandbox
 * globals); `vended` is enforced: only listed cap names survive attenuation.
 * `wallet` and `signing-rpc` are special-cased to also require `live`.
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
 * Build an interface-guarded, revocable wallet capability.
 *
 * The returned object exposes ONLY the whitelisted methods; calling anything
 * else throws. After `revoke()` every method throws `wallet capability
 * revoked`, so a reference retained past the dispatch is inert. This is the
 * plain-JS stand-in for an `@endo/exo` Far ref with an InterfaceGuard.
 *
 * In dry-run this is never constructed — the executor proves it by asserting
 * the wallet cap is absent from its attenuated set.
 *
 * @param {object} backing   the real signer (only ever built in --live from an out-of-tree keystore)
 * @param {string[]} [methods]  whitelisted method names (default: address, sign, submit)
 * @returns {{ cap: object, revoke: () => void }}
 */
export function makeWalletCapability(backing, methods = ['address', 'sign', 'submit']) {
  let revoked = false;
  const cap = {};
  for (const m of methods) {
    cap[m] = (...args) => {
      if (revoked) throw new CapabilityError('wallet capability revoked');
      if (typeof backing[m] !== 'function') {
        throw new CapabilityError(`wallet method not in interface guard: ${m}`);
      }
      return backing[m](...args);
    };
  }
  Object.freeze(cap);
  return { cap, revoke: () => { revoked = true; } };
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
 * Run `fn` with the role's attenuated capability set, then drop any vended
 * wallet so it cannot be re-invoked after the call returns. This is the
 * in-process analog of "the compartment is discarded; the wallet reference
 * becomes unreachable" from the design.
 *
 * The wallet revoke is wired by passing `walletRevoke` (the second tuple
 * element from `makeWalletCapability`) in `opts`; the runner calls it in a
 * `finally` so even a throwing `fn` drops the authority.
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
