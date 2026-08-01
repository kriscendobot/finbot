/**
 * Shared host/compartment boundary primitives.
 *
 * These are the security-critical helpers that must be byte-identical on both
 * sides of the role-program boundary: the host that dispatches a role program
 * and the worker thread that actually evaluates it. Keeping them in one module
 * means the JSON copy discipline, the assistant-message validator, and the
 * ambient-globals materializer cannot drift apart between the two runners.
 *
 * Importing this module locks down the realm (idempotently). Both `permissive.js`
 * (host) and `role-worker.js` (worker) import it, so both realms are hardened.
 */

import 'ses';

// --- lockdown guard (idempotent) ---

export function ensureLockdown() {
  if (Object.isFrozen(Object.prototype)) return;
  try {
    // This module runs host orchestration that retains diagnostic stacks on
    // SpawnHandle failures. `safe` clears those stacks process-wide. Role
    // programs receive only copied protocol data, and host failures are reduced
    // to a generic tool result before they can re-enter a later role turn.
    // Keeping SES's causal console would replace and then freeze the host
    // console. Retain the host console here and vend frozen wrappers below.
    lockdown({ errorTaming: 'unsafe', consoleTaming: 'unsafe', overrideTaming: 'severe' });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!/locked down|repairIntrinsics/i.test(message)) throw err;
  }
}
ensureLockdown();

// --- ambient-globals materializers ---

/**
 * Vend wrappers, not the live realm console. Hardening an endowment must never
 * freeze or otherwise alter the enclosing realm's process state.
 */
export function makeConsole() {
  const attenuated = {};
  for (const name of ['debug', 'error', 'info', 'log', 'warn']) {
    if (typeof console[name] === 'function') {
      attenuated[name] = (...args) => console[name](...args);
    }
  }
  return harden(attenuated);
}

/** Vend a callable capability without hardening the live realm fetch function. */
export function makeFetch() {
  return harden((...args) => fetch(...args));
}

/** Deterministic, seeded PRNG (mulberry32). */
export function makeSeededRandom(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function random() {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Materialize a role's ambient globals from an EXPLICIT token list.
 *
 * The token list is the narrowing decision, computed on the host by the
 * attenuator. This function never consults the capability map: it only builds
 * concrete endowments for the tokens it is handed, so it can never re-derive
 * authority behind the attenuator's back. The worker calls this to rebuild the
 * (unshippable, function-valued) globals the host attenuator chose.
 *
 * @param {string[]} tokens ambient tokens, e.g. ['console', 'rng']
 * @param {{ seed?: number }} [opts]
 * @returns {Record<string, unknown>}
 */
export function buildGlobalsFromTokens(tokens, opts = {}) {
  const globals = {};
  for (const raw of tokens) {
    const token = String(raw).trim();
    switch (token) {
      case 'console':
        globals.console = makeConsole();
        break;
      case 'fetch':
        if (typeof fetch === 'function') globals.fetch = makeFetch();
        break;
      case 'rng':
        globals.random = makeSeededRandom(opts.seed);
        break;
      default:
        throw new Error(`unknown ambient token: ${token}`);
    }
  }
  return globals;
}

// --- JSON boundary copy ---

/**
 * Copy a JSON data graph across the host/compartment boundary. Accessors and
 * symbols are rejected rather than invoked or silently dropped. BigInt is not
 * part of the wire format, so amount-bearing messages fail explicitly instead
 * of relying on engine-specific JSON.stringify wording.
 */
export function copyJsonData(value, label) {
  try {
    assertJsonData(value, label);
    const encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') {
        throw new TypeError('BigInt is not supported by the JSON boundary');
      }
      return item;
    });
    if (typeof encoded !== 'string') throw new TypeError('value does not encode as JSON');
    return JSON.parse(encoded);
  } catch (err) {
    const message = String((err && err.message) || err);
    throw new TypeError(`${label} must be JSON-serializable: ${message}`);
  }
}

/** Reject accessor, proxy-shaped, and symbol-bearing values before copying. */
export function assertJsonData(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite numbers`);
    return;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt is not supported by the JSON boundary');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must contain JSON values`);
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must not be an accessor property`);
    }
    assertJsonData(descriptor.value, `${label}.${key}`, seen);
  }
}

/** Validate the data-only assistant-message protocol at the host boundary. */
export function validateAssistantMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('runCompartmentLlm.result must be an assistant message object');
  }
  if (message.role !== 'assistant') {
    throw new TypeError('runCompartmentLlm.result.role must be "assistant"');
  }
  if (!Array.isArray(message.content)) {
    throw new TypeError('runCompartmentLlm.result.content must be an array');
  }
  for (const [index, item] of message.content.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string') {
      throw new TypeError(`runCompartmentLlm.result.content[${index}] must be a typed object`);
    }
    if (item.type === 'text' && typeof item.text !== 'string') {
      throw new TypeError(`runCompartmentLlm.result.content[${index}].text must be a string`);
    }
    if (item.type === 'toolCall') {
      if (typeof item.id !== 'string' || typeof item.name !== 'string') {
        throw new TypeError(`runCompartmentLlm.result.content[${index}] must name a tool and id`);
      }
      if (item.arguments !== undefined && (item.arguments === null || typeof item.arguments !== 'object' || Array.isArray(item.arguments))) {
        throw new TypeError(`runCompartmentLlm.result.content[${index}].arguments must be an object`);
      }
    }
  }
  if (message.stopReason !== undefined && typeof message.stopReason !== 'string') {
    throw new TypeError('runCompartmentLlm.result.stopReason must be a string when provided');
  }
  return message;
}

/** Add host-owned transcript fields before the message is hardened. */
export function normalizeAssistantMessage(message) {
  return { ...message, timestamp: Date.now() };
}
