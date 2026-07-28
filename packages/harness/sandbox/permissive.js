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

import { Worker } from 'node:worker_threads';

import {
  buildGlobalsFromTokens,
  copyJsonData,
  makeConsole,
  makeFetch,
  makeSeededRandom,
  normalizeAssistantMessage,
  validateAssistantMessage,
} from './boundary.js';

// Importing ./boundary.js locks down the realm idempotently for the host too.

const ROLE_WORKER_URL = new URL('./role-worker.js', import.meta.url);

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
 * Distill the attenuated globals the attenuator produced into a form that can
 * cross to the worker thread. This is where the attenuator's narrowing decision
 * becomes shippable data — reading the attenuated globals rather than
 * re-consulting CAPABILITY_MAP keeps the attenuator the sole narrowing point (a
 * caller-supplied attenuator that dropped `fetch` yields a descriptor without
 * it, and the worker then never materializes fetch).
 *
 * Two kinds of global cross differently:
 *   - The ambient capability endowments (`console`/`fetch`/`random`) are
 *     function-valued and cannot be serialized, so they travel as TOKENS the
 *     worker rebuilds locally from the same materializers.
 *   - Any other global a custom attenuator injects (a plain-data marker, config,
 *     etc.) travels VERBATIM as JSON-copied data.
 * A function-valued global outside the known ambient set cannot be shipped to a
 * worker at all, so it is rejected loudly rather than silently dropped.
 *
 * @returns {{ tokens: string[], dataGlobals: Record<string, unknown> }}
 */
function describeGlobals(globals) {
  const tokens = [];
  const dataGlobals = {};
  for (const [key, value] of Object.entries(globals || {})) {
    if (key === 'console' && value && typeof value === 'object') { tokens.push('console'); continue; }
    if (key === 'fetch' && typeof value === 'function') { tokens.push('fetch'); continue; }
    if (key === 'random' && typeof value === 'function') { tokens.push('rng'); continue; }
    if (typeof value === 'function') {
      throw new TypeError(
        `runCompartmentLlm cannot ship a function-valued global '${key}' to the worker; `
        + 'only console/fetch/rng ambient endowments and JSON-serializable data globals are supported',
      );
    }
    dataGlobals[key] = copyJsonData(value, `runCompartmentLlm.globals.${key}`);
  }
  return { tokens, dataGlobals };
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
 * The program runs in a dedicated worker thread (see `role-worker.js`), so a
 * non-yielding program blocks only its own thread and the host can terminate it
 * once `timeoutMs` elapses. Transport is JSON-only in both directions.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {string} args.source JavaScript expression evaluating to `(input) => message`
 * @param {object} args.input JSON-only data for one LLM turn
 * @param {object} [args.globals] the attenuated ambient-globals policy; when
 *   omitted, the role's default policy is derived for direct-caller convenience
 * @param {number} [args.timeoutMs] wall-clock bound for the turn; on overrun the
 *   worker is terminated and the call rejects. Omitted ⇒ no deadline.
 * @param {number} [args.seed] seed for the role's deterministic RNG endowment
 * @returns {Promise<object>} assistant message produced by the role program
 */
export async function runCompartmentLlm({ role, source, input, globals, timeoutMs, seed }) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new TypeError('runCompartmentLlm.source must be a non-empty string');
  }

  // Validate and copy the input to pure JSON on the HOST, so a non-serializable
  // input (BigInt, cycle, accessor) fails with a precise host-labeled error and
  // nothing but JSON is ever shipped to the worker.
  const inputJson = JSON.stringify(copyJsonData(input, 'runCompartmentLlm.input'));

  // The attenuator is the SOLE source of a role program's ambient globals. When
  // spawn() wires this adapter it threads the already-attenuated `globals`
  // policy through; we distill it to an explicit token list — the only form
  // that can cross to the worker — so a caller-supplied attenuator that narrows
  // globals is honored, and the worker never re-derives authority from
  // CAPABILITY_MAP behind the attenuator's back. Direct callers that omit
  // `globals` fall back to the role's default policy for convenience.
  const rolePolicy = globals || buildRolePolicy(role, { seed });
  const { tokens, dataGlobals } = describeGlobals(rolePolicy);
  const dataGlobalsJson = JSON.stringify(dataGlobals);

  // Run the untrusted program in a worker THREAD, not on the host event loop.
  // A non-yielding program blocks its own thread, never the host's, so the host
  // stays free to enforce `timeoutMs` and terminate the worker — the preemption
  // an in-process `await program(...)` could never deliver (blocked-loop bug).
  const resultJson = await runInRoleWorker({
    role, source, inputJson, tokens, dataGlobalsJson, seed, timeoutMs,
  });

  // The worker already copied the program result to pure JSON (rejecting
  // accessors/proxies/symbols on its side, where the live object existed). The
  // host performs the final, authoritative protocol validation before spawn.js
  // sees any content, tool name, or tool argument.
  const result = JSON.parse(resultJson);
  return harden(normalizeAssistantMessage(validateAssistantMessage(result)));
}

/**
 * Run one role-program turn in a dedicated worker thread and resolve to the
 * worker's JSON result string. Rejects — after terminating the worker — if the
 * program throws, the worker dies, or `timeoutMs` elapses. Terminating a worker
 * stuck in a synchronous loop is the one preemption the host thread cannot
 * perform on itself.
 *
 * @param {object} job
 * @returns {Promise<string>} the worker's `resultJson`
 */
function runInRoleWorker({ role, source, inputJson, tokens, dataGlobalsJson, seed, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(ROLE_WORKER_URL);
    let settled = false;
    let timer;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Fire-and-forget: reclaim the thread whether it finished, failed, or is
      // still spinning. terminate() interrupts even a tight synchronous loop.
      worker.terminate();
      fn(arg);
    };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(
        () => finish(reject, new Error(`role program timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (timer.unref) timer.unref();
    }
    worker.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.resultJson);
      else finish(reject, new TypeError((msg && msg.error) || 'role worker failed without a message'));
    });
    worker.once('error', (err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`role worker exited with code ${code}`));
    });
    worker.postMessage({ role, source, inputJson, tokens, dataGlobalsJson, seed });
  });
}
