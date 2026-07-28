/**
 * Role-program worker.
 *
 * A role program is untrusted JavaScript (v1 will be LLM-authored). Running it
 * on the host event-loop thread means a non-yielding program — `while (true) {}`
 * or a synchronous CPU bomb — blocks the loop forever, so the host's `timeoutMs`
 * deadline (a `setTimeout` / `Promise.race`) can never fire to preempt it.
 *
 * This module runs one role-program turn in a dedicated worker thread. The host
 * sends a JSON-only turn descriptor, the worker evaluates the program in a
 * hardened SES Compartment and posts back a JSON-only assistant message. If the
 * program never yields, the host calls `worker.terminate()`, which V8 honors
 * even against a tight synchronous loop — the preemption the host thread cannot
 * perform on itself.
 *
 * The worker is spawn-fresh per turn (the cap-attenuation design's safer default
 * for state hygiene) and holds no capability beyond the ambient globals the host
 * attenuator chose, rebuilt here from an explicit token list.
 */

import { parentPort } from 'node:worker_threads';

import { ensureLockdown, buildGlobalsFromTokens, copyJsonData } from './boundary.js';

ensureLockdown();

function fail(err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}

parentPort.once('message', (msg) => {
  try {
    const { role, source, inputJson, tokens, dataGlobalsJson, seed } = msg;

    // Materialize ambient globals from the host-chosen token list, then overlay
    // any JSON data globals the attenuator injected. This worker never consults
    // the capability map, so it cannot widen authority beyond what the host
    // attenuator narrowed to: it only rebuilds endowments the host named.
    const ambient = buildGlobalsFromTokens(tokens || [], { seed });
    const dataGlobals = dataGlobalsJson ? JSON.parse(dataGlobalsJson) : {};
    const compartment = new Compartment({
      globals: harden({ ...ambient, ...dataGlobals }),
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

    const input = harden(JSON.parse(inputJson));

    // `program(input)` may be synchronous (and may never return, in which case
    // the host terminates this worker) or may return a promise. Route both
    // through the same copy + post path.
    Promise.resolve()
      .then(() => program(input))
      .then((result) => {
        // Copy to host-owned JSON on THIS side of the boundary: accessors,
        // proxies, symbols, and BigInt are rejected here with the precise
        // messages the host contract promises, while the live compartment
        // object is still reachable. The host performs the final protocol
        // validation on the parsed JSON it receives.
        const copied = copyJsonData(result, 'runCompartmentLlm.result');
        parentPort.postMessage({ ok: true, resultJson: JSON.stringify(copied) });
      })
      .catch(fail);
  } catch (err) {
    fail(err);
  }
});
