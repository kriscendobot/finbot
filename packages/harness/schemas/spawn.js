/**
 * Subagent spawn parameter shape and validator.
 *
 *   interface SpawnParams {
 *     role: string;              // matches roles/<role>/AGENT.md
 *     brief: string;             // the dispatch prompt body
 *     capabilities?: string[];   // names of tools the subagent may invoke
 *     attenuator?: Function;     // overrides the default permissive attenuator
 *     llm?: Function;            // overrides the default deterministic stub LLM
 *     timeoutMs?: number;        // default 10 minutes
 *     observationKind?: string;  // 'dispatch' by default
 *   }
 *
 *   interface SpawnHandle {
 *     id: string;
 *     role: string;
 *     status: 'pending' | 'running' | 'completed' | 'errored' | 'aborted';
 *     started: number;     // ms epoch
 *     finished?: number;
 *     events: AgentEvent[];
 *     result?: { messages: AgentMessage[]; finalText: string };
 *     error?: { message: string; stack?: string };
 *   }
 *
 * The handle's `events` array is a Pi-shaped event stream snapshot:
 * `agent_start`, `turn_start`, `message_start`, `tool_execution_start`,
 * `tool_execution_end`, `turn_end`, `agent_end`. The harness's
 * observation/monitor walks this array to render progress.
 */

export class SpawnParamsError extends Error {}

/**
 * @param {unknown} p
 */
export function assertSpawnParams(p) {
  if (p === null || typeof p !== 'object') {
    throw new SpawnParamsError('spawn params must be an object');
  }
  const params = /** @type {Record<string, unknown>} */ (p);
  if (typeof params.role !== 'string' || params.role.length === 0) {
    throw new SpawnParamsError('spawn.role must be a non-empty string');
  }
  if (typeof params.brief !== 'string') {
    throw new SpawnParamsError('spawn.brief must be a string');
  }
  if (params.capabilities !== undefined) {
    if (!Array.isArray(params.capabilities)) {
      throw new SpawnParamsError('spawn.capabilities must be an array of strings when provided');
    }
    for (const cap of params.capabilities) {
      if (typeof cap !== 'string') {
        throw new SpawnParamsError('spawn.capabilities[i] must be a string');
      }
    }
  }
  if (params.attenuator !== undefined && typeof params.attenuator !== 'function') {
    throw new SpawnParamsError('spawn.attenuator must be a function when provided');
  }
  if (params.llm !== undefined && typeof params.llm !== 'function') {
    throw new SpawnParamsError('spawn.llm must be a function when provided');
  }
  if (params.timeoutMs !== undefined) {
    if (typeof params.timeoutMs !== 'number' || params.timeoutMs <= 0) {
      throw new SpawnParamsError('spawn.timeoutMs must be a positive number when provided');
    }
  }
  if (params.observationKind !== undefined && typeof params.observationKind !== 'string') {
    throw new SpawnParamsError('spawn.observationKind must be a string when provided');
  }
}
