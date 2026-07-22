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
    lockdown({ errorTaming: 'unsafe', overrideTaming: 'severe' });
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
        globals.console = console;
        if (typeof fetch === 'function') globals.fetch = fetch;
        break;
      default:
        throw new Error(`unknown ambient token for role ${role}: ${token}`);
    }
  };
  for (const token of entry.ambient.split(',')) grant(token.trim());
  return globals;
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

  // JSON serialization makes the data crossing into the compartment a copy,
  // never a mutable host object graph. The prompt/messages/tool names are all
  // data by contract, so reject values that do not meet that boundary.
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(input));
  } catch (err) {
    throw new TypeError(`runCompartmentLlm.input must be JSON-serializable: ${err.message}`);
  }

  const globals = buildRolePolicy(role, {});
  const compartment = new Compartment({
    globals: harden({ ...globals, input: harden(snapshot) }),
    __options__: true,
    name: `role-program:${role}`,
  });
  const program = compartment.evaluate(`(${source})`);
  if (typeof program !== 'function') {
    throw new TypeError('runCompartmentLlm.source must evaluate to a function');
  }
  return await program(snapshot);
}
