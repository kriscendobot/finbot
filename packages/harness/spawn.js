/**
 * Subagent spawn.
 *
 * Spawns an LLM-shaped subagent: load the role's `AGENT.md`, attenuate
 * its capability surface to the requested subset of tools, drive an
 * inner agent loop that produces messages and tool calls, and return a
 * SpawnHandle whose `events` stream a monitor can `for await`.
 *
 * v0 implements:
 *
 *   - Role file loading from `<finbotRoot>/roles/<role>/AGENT.md`.
 *   - Capability attenuation via the permissive v0 attenuator (or any
 *     injected attenuator).
 *   - A deterministic stub LLM that produces a canned tool-call
 *     sequence; tests inject their own `llm` to drive specific shapes.
 *
 * v1 replaces the stub LLM with the Anthropic / OpenAI / Ollama
 * provider per the project's references shelf, and replaces the
 * permissive attenuator with `@endo/compartment-mapper`.
 *
 * Pi-borrowed shape: the event stream `agent_start` / `turn_start` /
 * `message_start` / `tool_execution_start` / `tool_execution_end` /
 * `turn_end` / `agent_end` mirrors `@earendil-works/pi-agent`'s
 * `AgentEvent` union.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

import { assertSpawnParams } from './schemas/spawn.js';
import { permissiveAttenuator } from './sandbox/permissive.js';

/**
 * Spawn a subagent in this process.
 *
 * @param {object} params SpawnParams; see schemas/spawn.js
 * @param {object} ctx parent context (must carry `tools` and `finbotRoot`)
 * @returns {Promise<object>} SpawnHandle
 */
export async function spawn(params, ctx) {
  assertSpawnParams(params);
  const attenuator = params.attenuator || permissiveAttenuator;
  const llm = params.llm || stubLlm;
  const timeoutMs = params.timeoutMs || 10 * 60 * 1000;

  const id = shortId();
  const started = Date.now();
  const events = [];
  const handle = {
    id,
    role: params.role,
    status: 'pending',
    started,
    events,
    result: undefined,
    error: undefined,
  };

  // load the role file
  let roleBrief = '';
  if (ctx.finbotRoot) {
    const rolePath = path.join(ctx.finbotRoot, 'roles', params.role, 'AGENT.md');
    try {
      roleBrief = await fs.readFile(rolePath, 'utf8');
    } catch (err) {
      // a role file that doesn't exist is a soft error: the subagent gets
      // an empty role brief and the spawn proceeds with just the dispatch
      // brief. This makes the harness usable on a partially-grown library.
      roleBrief = `# Role ${params.role}\n\n(role file missing at ${rolePath})\n`;
    }
  }

  // attenuate capabilities
  const attenuated = attenuator(params.role, params.capabilities, ctx);

  // run asynchronously; the caller awaits the handle's result via the
  // returned promise pattern.
  handle.status = 'running';
  events.push({ type: 'agent_start', role: params.role, id });

  const runner = (async () => {
    const deadline = timeout(timeoutMs);
    try {
      const result = await Promise.race([
        runLoop({ params, ctx, attenuated, roleBrief, events, llm }),
        deadline.promise,
      ]);
      handle.status = 'completed';
      handle.result = result;
      handle.finished = Date.now();
      events.push({ type: 'agent_end', messages: result.messages });
      return handle;
    } catch (err) {
      handle.status = err.message === 'timeout' ? 'aborted' : 'errored';
      handle.error = { message: err.message, stack: err.stack };
      handle.finished = Date.now();
      events.push({ type: 'agent_end', error: handle.error, messages: [] });
      return handle;
    } finally {
      // Clear the deadline timer so a completed spawn does not keep the
      // event loop (and `node --test`) alive until the 10-minute timeout
      // fires. Without this the process hangs at exit after every spawn.
      deadline.cancel();
    }
  })();

  handle.done = runner;
  return handle;
}

/**
 * Inner loop: emit a turn_start, ask llm for an assistant message, run
 * any requested tool calls, emit turn_end. Repeat until the assistant
 * stops (no tool calls + stopReason 'end_turn') or hits the iteration cap.
 *
 * The v0 stub LLM produces a single turn that names a tool to invoke
 * (so a test can observe the tool surface working) and then ends; tests
 * can inject richer llms to drive multi-turn behavior.
 */
async function runLoop({ params, ctx, attenuated, roleBrief, events, llm }) {
  const messages = [];
  const maxTurns = 8;

  // prompt
  const systemPrompt = composeSystemPrompt(params.role, roleBrief);
  const userMessage = { role: 'user', content: params.brief, timestamp: Date.now() };
  events.push({ type: 'message_start', message: userMessage });
  messages.push(userMessage);
  events.push({ type: 'message_end', message: userMessage });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    events.push({ type: 'turn_start', turn });
    const assistantMessage = await llm({
      systemPrompt,
      messages,
      tools: attenuated.tools,
      role: params.role,
      turn,
    });
    events.push({ type: 'message_start', message: assistantMessage });
    messages.push(assistantMessage);
    events.push({ type: 'message_end', message: assistantMessage });

    const toolCalls = (assistantMessage.content || []).filter((c) => c && c.type === 'toolCall');
    if (toolCalls.length === 0) {
      events.push({ type: 'turn_end', message: assistantMessage, toolResults: [] });
      if (assistantMessage.stopReason === 'end_turn' || assistantMessage.stopReason === 'stop') {
        break;
      }
      // no tool call but didn't stop: still terminate to avoid runaway
      break;
    }

    const toolResults = [];
    for (const tc of toolCalls) {
      events.push({ type: 'tool_execution_start', toolCall: tc });
      const tool = attenuated.tools[tc.name];
      let result;
      if (!tool) {
        result = { ok: false, content: [{ type: 'text', text: `tool ${tc.name} not in subagent capability set` }] };
      } else {
        try {
          result = await tool.run(tc.arguments || {}, { role: params.role });
        } catch (err) {
          result = { ok: false, content: [{ type: 'text', text: String(err.message || err) }] };
        }
      }
      const toolResultMessage = {
        role: 'toolResult',
        toolCallId: tc.id,
        content: result.content,
        isError: !result.ok,
        timestamp: Date.now(),
      };
      events.push({ type: 'tool_execution_end', toolCall: tc, result: toolResultMessage });
      messages.push(toolResultMessage);
      toolResults.push(toolResultMessage);
    }
    events.push({ type: 'turn_end', message: assistantMessage, toolResults });
  }

  const finalText = extractFinalText(messages);
  return { messages, finalText };
}

function composeSystemPrompt(role, roleBrief) {
  return [
    `You are operating as the finbot ${role}.`,
    '',
    'Standing instructions and role brief follow.',
    '',
    roleBrief,
  ].join('\n');
}

function extractFinalText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (Array.isArray(m.content)) {
      const texts = m.content.filter((c) => c && c.type === 'text').map((c) => c.text);
      if (texts.length > 0) return texts.join('\n');
    } else if (typeof m.content === 'string') {
      return m.content;
    }
  }
  return '';
}

/**
 * Deterministic stub LLM. On turn 0, calls the first available tool with
 * the brief as the argument's `text` field; on turn 1, stops. Tests
 * inject their own LLM to drive richer behavior.
 *
 * @param {object} args
 */
function stubLlm(args) {
  if (args.turn === 0) {
    const firstTool = Object.values(args.tools)[0];
    if (firstTool) {
      const toolCallId = crypto.randomBytes(4).toString('hex');
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: `Calling ${firstTool.name}` },
          {
            type: 'toolCall',
            id: toolCallId,
            name: firstTool.name,
            arguments: { brief: args.messages[0].content },
          },
        ],
        stopReason: 'tool_use',
        timestamp: Date.now(),
      };
    }
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'Stub LLM: no further action.' }],
    stopReason: 'end_turn',
    timestamp: Date.now(),
  };
}

/**
 * A cancelable deadline. Returns a rejecting promise and a `cancel()` that
 * clears the underlying timer so a settled race does not leak it.
 *
 * @param {number} ms
 * @returns {{ promise: Promise<never>, cancel: () => void }}
 */
function timeout(ms) {
  let handle;
  const promise = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

function shortId() {
  return crypto.randomBytes(3).toString('hex');
}
