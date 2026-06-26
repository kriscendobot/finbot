/**
 * @finbot/harness — public API.
 *
 * The harness exposes:
 *
 *   - `run(config)` — top-level driver: parse safety, decide once vs
 *     persistent, drive ticks.
 *   - `loop` — the OODA tick. One function so a test can drive it
 *     synchronously without going through `run`.
 *   - `spawn` — subagent spawning with a cap-attenuation hook.
 *   - `providers` — real LLM providers for the spawn `llm` hook (the stub
 *     stays the default; `providers.makeAnthropicLlm()` is the inference path).
 *   - `tools` — the tool registry.
 *   - `messageBus` — inbox + job-board over the journal.
 *   - `observation` — record + monitor.
 *   - `schemas` — JSON-schema-shaped validators for the tool def
 *     and spawn param shapes.
 */

import { runOnce, runPersistent } from './loop.js';
import * as spawnModule from './spawn.js';
import * as providers from './providers/index.js';
import * as toolsModule from './tools.js';
import * as messageBus from './message-bus/index.js';
import * as observation from './observation/index.js';
import * as schemas from './schemas/index.js';
import { permissiveAttenuator } from './sandbox/permissive.js';

export { runOnce, runPersistent };
export { spawnModule as spawn };
export { providers };
export { toolsModule as tools };
export { messageBus, observation, schemas };
export { permissiveAttenuator };

/**
 * Top-level driver. Called by `bin/finbot`.
 *
 * @param {object} config
 * @param {'once' | 'persistent'} config.mode
 * @param {'dry-run' | 'live'} config.safety
 * @param {number} [config.cadenceMs]
 * @param {string} config.finbotRoot
 * @param {string} config.journalRoot
 */
export async function run(config) {
  if (config.mode === 'persistent') {
    await runPersistent(config);
  } else {
    await runOnce(config);
  }
}
