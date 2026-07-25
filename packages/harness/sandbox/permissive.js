/**
 * Capability attenuator for the finbot harness.
 *
 * **v0 (permissiveAttenuator):** runs subagents in-process with every host
 * capability available. This is the "the LLM correctly follows the prompt"
 * security posture — appropriate for v0 (executor is dry-run by default;
 * subagents are stubs) but unacceptable once the executor signs live
 * transactions.
 *
 * **v1 (compartmentAttenuator):** supplies a hardened SES role policy whose
 * globals are exactly the role's ambient policy and whose tools are the vended
 * capability slice. `runCompartmentLlm` executes an optional role-program in a
 * real SES Compartment. The program receives immutable prompt data and names
 * of its allowed tools, then returns a tool-call message for the host to run.
 *
 * Both are exported; the harness defaults to `compartmentAttenuator`. Callers
 * may opt into `permissiveAttenuator` only for legacy or test-double use.
 */

import 'ses';

// --- lockdown guard (idempotent) ---

function ensureLockdown() {
  if (Object.isFrozen(Object.prototype)) return;
  try {
    // Role programs are untrusted. Do not expose host error details to them.
    // Keeping SES's causal console would replace and then freeze the host
    // console. Retain the host console here and vend frozen wrappers below.
    lockdown({ errorTaming: 'safe', consoleTaming: 'unsafe', overrideTaming: 'severe' });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!/locked down|repairIntrinsics/i.test(message)) throw err;
  }
}
ensureLockdown();

// --- capability map (mirrors designs/cap-attenuation.md § Capability map) ---

const CAPABILITY_MAP = {
  liaison:        { ambient: 'full', vended: [] },
  steward:        { ambient: 'bounded', vended: [] },
  'oracle-watcher': { ambient: 'fetch,console', vended: [] },
  monitor:        { ambient: 'console', vended: ['rpc-read'] },
  forecaster:     { ambient: 'console,rng', vended: [] },
  analyzer:       { ambient: 'console', vended: ['forecaster-results', 'monitor-results'] },
  planner:        { ambient: 'console', vended: ['analyzer-results', 'forecasts', 'rpc-read'] },
  auditor:        { ambient: 'console', vended: ['rpc-read', 'planner-result'] },
  executor:       { ambient: 'console', vended: ['rpc-read', 'wallet', 'signing-rpc'] },
  journalist:     { ambient: 'console', vended: ['journal-read'] },
};

/** Build the SES globals policy for a role. */
function buildRolePolicy(role, opts = {}) {
  const entry = CAPABILITY_MAP[role];
  if (!entry) throw new Error(`unknown role for attenuation: ${role}`);
  const globals = {};
  const grant = (token) => {
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
      case 'full':
      case 'bounded':
        globals.console = makeConsole();
        if (typeof fetch === 'function') globals.fetch = makeFetch();
        break;
      default:
        throw new Error(`unknown ambient token for role ${role}: ${token}`);
    }
  };
  for (const token of entry.ambient.split(',')) grant(token.trim());
  return globals;
}

/**
 * Vend wrappers, not the live host console. Hardening an endowment must never
 * freeze or otherwise alter host process state.
 */
function makeConsole() {
  const attenuated = {};
  for (const name of ['debug', 'error', 'info', 'log', 'warn']) {
    if (typeof console[name] === 'function') {
      attenuated[name] = (...args) => console[name](...args);
    }
  }
  return harden(attenuated);
}

/** Vend a callable capability without hardening the live host fetch function. */
function makeFetch() {
  return harden((...args) => fetch(...args));
}

/** Deterministic, seeded PRNG (mulberry32). */
function makeSeededRandom(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function random() {
    a |= 0; a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- v0: explicit opt-out for legacy and test-double use ---

/**
 * Permissive v0 capability attenuator.
 * The executor is dry-run by default and subagents are stubs, so the full
 * capability surface is safe enough for development.
 *
 * @param {string} role
 * @param {string[]|null} capabilities
 * @param {object} parentContext
 * @returns {{ globals: Record<string, unknown>, modules: Record<string, unknown>, tools: Record<string, any> }}
 */
export function permissiveAttenuator(role, capabilities, parentContext) {
  const tools = parentContext.tools || {};
  let toolSubset = tools;
  if (capabilities && capabilities.length > 0) {
    toolSubset = {};
    for (const cap of capabilities) {
      if (tools[cap]) toolSubset[cap] = tools[cap];
    }
  }
  return {
    globals: parentContext.globals || {},
    modules: parentContext.modules || {},
    tools: toolSubset,
  };
}

// --- v1: SES compartment policy (harness default) ---

/**
 * V1 capability attenuator. It returns the hardened role policy that a
 * Compartment runner consumes, plus plain endowments filtered by granted
 * capabilities.
 *
 * The return shape matches the future `@endo/compartment-mapper` interface so
 * callers need not change when we swap implementations later.
 *
 * @param {string} role
 * @param {string[]|null} capabilities   names of tools to vend
 * @param {object} parentContext         host context carrying tools, globals, modules
 * @returns {{ globals: Record<string, unknown>, modules: Record<string, unknown>, tools: Record<string, any> }}
 */
export function compartmentAttenuator(role, capabilities = null, parentContext = {}) {
  const entry = CAPABILITY_MAP[role];
  if (!entry) throw new Error(`unknown role for attenuation: ${role}`);

  // Build the globals policy for this role.
  const globals = buildRolePolicy(role, {});

  // Filter tools to the granted capabilities.
  const allTools = parentContext.tools || {};
  let toolSubset = allTools;
  if (capabilities && capabilities.length > 0) {
    toolSubset = {};
    for (const cap of capabilities) {
      if (allTools[cap]) toolSubset[cap] = allTools[cap];
    }
  }

  return harden({
    globals,
    modules: parentContext.modules || {},
    tools: toolSubset,
  });
}

/**
 * Run a role program inside a real SES Compartment.
 *
 * The program source must evaluate to a function. That function receives a
 * JSON-only immutable snapshot of one LLM turn and returns the assistant
 * message for that turn. It receives tool names as data, not host tool
 * objects: only the host performs a requested tool call after the result has
 * crossed back over the compartment boundary.
 *
 * Keeping the capability invocation in the host is deliberate. A role program
 * may decide which of its granted tools to request, but it cannot retain,
 * mutate, or inspect a host tool object. Its process, filesystem, and network
 * access therefore remain the explicit role-policy question, not an accidental
 * consequence of the LLM adapter being JavaScript.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {string} args.source JavaScript expression evaluating to `(input) => message`
 * @param {object} args.input JSON-only data for one LLM turn
 * @returns {Promise<object>} assistant message produced by the role program
 */
export async function runCompartmentLlm({ role, source, input }) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new TypeError('runCompartmentLlm.source must be a non-empty string');
  }

  const snapshot = copyJsonData(input, 'runCompartmentLlm.input');

  const globals = buildRolePolicy(role, {});
  const compartment = new Compartment({
    globals: harden({ ...globals }),
    __options__: true,
    name: `role-program:${role}`,
  });
  let program;
  try {
    program = compartment.evaluate(`(${source})`);
  } catch (err) {
    throw new TypeError(`runCompartmentLlm.source must be valid JavaScript: ${err.message}`);
  }
  if (typeof program !== 'function') {
    throw new TypeError('runCompartmentLlm.source must evaluate to a function');
  }
  // A compartment object is not safe for the host to consume directly. Copy
  // it to host-owned JSON data, then validate the message before spawn.js sees
  // its content, tool names, or tool arguments.
  const result = await program(harden(snapshot));
  return validateAssistantMessage(copyJsonData(result, 'runCompartmentLlm.result'));
}

/**
 * Copy a JSON data graph across the host/compartment boundary. Accessors and
 * symbols are rejected rather than invoked or silently dropped. BigInt is not
 * part of the wire format, so amount-bearing messages fail explicitly instead
 * of relying on engine-specific JSON.stringify wording.
 */
function copyJsonData(value, label) {
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
function assertJsonData(value, label, seen = new WeakSet()) {
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
function validateAssistantMessage(message) {
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
  return harden(message);
}
