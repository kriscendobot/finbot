/**
 * Permissive v0 capability attenuator.
 *
 * The v0 harness runs subagents in-process and exposes every host
 * capability. This is the "the LLM correctly follows the prompt"
 * security posture, equivalent to running an unsandboxed coding agent.
 * It is appropriate for v0 (the executor is dry-run by default; the
 * subagents are stubs) but is **not** an acceptable posture once the
 * executor signs live transactions.
 *
 * The v1 path replaces this stub with `@endo/compartment-mapper`. Each
 * role's `AGENT.md` frontmatter declares the modules and globals it
 * may import; the compartment-mapper builds a policy from those
 * declarations and the harness instantiates the role's code inside a
 * Compartment with that policy in force. Cross-compartment objects are
 * vended as `@endo/exo` (Far + InterfaceGuard) so even a misbehaving
 * role cannot bypass an InterfaceGuard at runtime.
 *
 * The shape this stub exposes to `spawn.js` is the same shape the v1
 * attenuator will expose:
 *
 *   attenuator(role, capabilities, parentContext) -> {
 *     globals,     // map<string, unknown>
 *     modules,     // map<string, unknown>
 *     tools,       // filtered tool registry the subagent may call
 *   }
 *
 * v0 returns the parent's tools verbatim, the parent's globals (read-only
 * proxy), and an empty modules map. v1 will replace each of these with
 * the attenuated equivalent.
 */

/**
 * @param {string} role
 * @param {string[]} capabilities
 * @param {object} parentContext
 * @returns {{ globals: Record<string, unknown>, modules: Record<string, unknown>, tools: Record<string, import('../schemas/tool.js').Tool> }}
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

/**
 * V1 attenuator stub. Throws if anyone tries to use the v1 hook in v0.
 * The signature is here so the spawn module can be wired against the
 * future shape without ambiguity.
 */
export function compartmentAttenuator() {
  throw new Error('compartmentAttenuator: not yet implemented; v0 ships permissiveAttenuator only. See designs/cap-attenuation.md for the @endo/compartment-mapper path.');
}
