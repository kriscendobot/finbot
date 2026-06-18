/**
 * Subagent monitor.
 *
 * A subagent spawned via `spawn.js` returns a `SpawnHandle` carrying:
 *
 *   - `id`, `role`, `status`
 *   - `events` — a Pi-shaped event stream (agent_start, turn_start,
 *     message_start, tool_execution_start, tool_execution_end, turn_end,
 *     agent_end)
 *   - `result` — final messages and final text, once the agent ends
 *
 * `monitorSubagent(handle)` returns an async iterable over events. The
 * driver can `for await` it to render progress, and stream-record each
 * event as a `tick` entry tied to the dispatch.
 *
 * Borrowed from Pi's EventStream pattern (`packages/agent/src/agent-loop.ts`).
 */

import { recordEntry } from './record.js';

/**
 * Monitor a spawn handle: yield events as they arrive, terminating when
 * the agent ends.
 *
 * @param {object} handle SpawnHandle
 * @returns {AsyncIterable<object>}
 */
export async function* monitorSubagent(handle) {
  let cursor = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    while (cursor < handle.events.length) {
      yield handle.events[cursor];
      cursor += 1;
    }
    if (handle.status === 'completed' || handle.status === 'errored' || handle.status === 'aborted') {
      // drain any remaining events that were appended before status flipped
      while (cursor < handle.events.length) {
        yield handle.events[cursor];
        cursor += 1;
      }
      return;
    }
    await sleep(25);
  }
}

/**
 * Record every event from a monitor stream into the journal as a single
 * `tick` entry batch.
 *
 * @param {string} journalRoot
 * @param {object} handle SpawnHandle
 * @param {object} [opts]
 * @param {boolean} [opts.localOnly]
 */
export async function recordSubagentTrace(journalRoot, handle, opts = {}) {
  const events = [];
  for await (const ev of monitorSubagent(handle)) {
    events.push(ev);
  }
  const body = [
    `# Subagent trace ${handle.id} (role=${handle.role})`,
    '',
    `status: ${handle.status}`,
    `started: ${new Date(handle.started).toISOString()}`,
    handle.finished ? `finished: ${new Date(handle.finished).toISOString()}` : null,
    `events: ${events.length}`,
    '',
    '## Events',
    '',
    ...events.map((ev) => `- ${ev.type}${ev.message ? ` ${ev.message.role || ''}` : ''}`),
  ]
    .filter((l) => l !== null)
    .join('\n');
  return recordEntry(journalRoot, {
    kind: 'tick',
    role: handle.role,
    body,
  }, opts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
