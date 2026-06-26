/**
 * Anthropic provider for the harness `llm` injection point.
 *
 * `spawn.js` drives an inner agent loop that, each turn, calls an injected
 * `llm({ systemPrompt, messages, tools, role, turn })` and expects a harness
 * assistant message back (see `spawn.js` § runLoop and § stubLlm for the
 * contract). v0 shipped a deterministic stub; this is the v1 real provider:
 * it translates the harness message/tool shapes to the Anthropic Messages API,
 * makes one `POST /v1/messages` call, and translates the response back.
 *
 * The stub stays the default everywhere (`spawn.js` falls back to it when no
 * `llm` is passed), so the harness and pipeline test suites remain offline and
 * deterministic. A caller that wants inference passes `llm: makeAnthropicLlm()`
 * explicitly; nothing reaches the network unless that function is invoked.
 *
 * Self-contained on purpose: the call uses the runtime's global `fetch`
 * (Node 20+) rather than `@anthropic-ai/sdk`, so `@finbot/harness` keeps its
 * no-dependency stance. The three translation functions are pure and exported
 * so the provider can be unit-tested without a key or a socket.
 *
 * Model defaults to `claude-opus-4-8`. Thinking is **disabled** by default:
 * the harness message model (`{ type: 'text' | 'toolCall' }`) is lossy and
 * cannot round-trip a thinking block's opaque signature across a tool-use
 * turn, which the Messages API requires when thinking is enabled. A future
 * iteration that preserves raw provider blocks per turn can switch this to
 * `{ type: 'adaptive' }`; until then, disabling thinking is the correct choice
 * for a loop that reconstructs messages from the simplified representation.
 */

import process from 'node:process';

import { toolsToLlmShape } from '../tools.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Build an `llm` function suitable for `spawn({ ..., llm })`.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey]      defaults to `process.env.ANTHROPIC_API_KEY`
 * @param {string} [options.model]       defaults to `claude-opus-4-8`
 * @param {number} [options.maxTokens]   defaults to 4096
 * @param {string} [options.effort]      `output_config.effort` (default 'high')
 * @param {object} [options.thinking]    Messages API thinking config (default `{ type: 'disabled' }`)
 * @param {string} [options.baseUrl]     API base (default `https://api.anthropic.com`)
 * @param {Function} [options.fetch]     fetch implementation (default `globalThis.fetch`); injectable for tests
 * @returns {(args: object) => Promise<object>} an `llm` matching the spawn contract
 */
export function makeAnthropicLlm(options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  const model = options.model || DEFAULT_MODEL;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const effort = options.effort || 'high';
  const thinking = options.thinking || { type: 'disabled' };
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = options.fetch || globalThis.fetch;

  return async function anthropicLlm({ systemPrompt, messages, tools }) {
    if (!apiKey) {
      throw new Error(
        'makeAnthropicLlm: no API key. Pass options.apiKey or set ANTHROPIC_API_KEY. '
        + 'The deterministic stub LLM remains the default for offline tests.',
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('makeAnthropicLlm: no fetch implementation (need Node 20+ or options.fetch).');
    }

    const toolList = toAnthropicToolList(tools);
    const body = {
      model,
      max_tokens: maxTokens,
      thinking,
      output_config: { effort },
      system: systemPrompt,
      messages: toAnthropicMessages(messages),
    };
    // Omit `tools` when empty: the API rejects an empty tools array.
    if (toolList.length > 0) body.tools = toolList;

    const res = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error(`anthropic provider: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
    }

    const data = await res.json();
    return fromAnthropicResponse(data);
  };
}

/**
 * Translate the harness message log into Anthropic Messages API messages.
 *
 * Harness shapes (see `spawn.js`):
 *   - user:       { role: 'user', content: <string> }
 *   - assistant:  { role: 'assistant', content: [ {type:'text',text} | {type:'toolCall',id,name,arguments} ] }
 *   - toolResult: { role: 'toolResult', toolCallId, content: [ {type:'text',text} | {type:'json',value} ], isError }
 *
 * A toolResult becomes a single-block `user` message; consecutive user-role
 * messages are combined by the API, so a turn with several tool calls produces
 * several user messages that the API folds into one turn.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : stringifyContent(m.content) });
    } else if (m.role === 'assistant') {
      const blocks = [];
      for (const c of m.content || []) {
        if (!c) continue;
        if (c.type === 'text') {
          if (c.text && c.text.length > 0) blocks.push({ type: 'text', text: c.text });
        } else if (c.type === 'toolCall') {
          blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} });
        }
      }
      // An assistant turn must carry at least one block.
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(no content)' });
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'toolResult') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: toolResultContent(m.content),
          is_error: !!m.isError,
        }],
      });
    }
  }
  return out;
}

/**
 * Render a harness tool registry (keyed by name) into the Anthropic tool list.
 *
 * @param {Record<string, object>} tools
 * @returns {Array<{ name: string, description: string, input_schema: object }>}
 */
export function toAnthropicToolList(tools) {
  if (!tools) return [];
  return toolsToLlmShape(tools);
}

/**
 * Translate an Anthropic Messages API response into a harness assistant
 * message. `tool_use` blocks become harness `toolCall` blocks (so `spawn.js`'s
 * loop executes them); `stop_reason` passes through as `stopReason` (the loop
 * treats `end_turn`/`stop` as terminal and runs tools whenever `toolCall`
 * blocks are present, which matches Anthropic's `tool_use` stop reason).
 *
 * Empty thinking blocks (the default when thinking is summarized/omitted) are
 * dropped; a non-empty thinking summary is surfaced as a leading text block.
 *
 * @param {object} data Anthropic Messages API response body
 * @returns {object} harness assistant message
 */
export function fromAnthropicResponse(data) {
  const content = [];
  for (const block of (data && data.content) || []) {
    if (!block) continue;
    if (block.type === 'text') {
      if (block.text && block.text.length > 0) content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.input || {} });
    } else if (block.type === 'thinking') {
      if (block.thinking && block.thinking.length > 0) content.push({ type: 'text', text: block.thinking });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    role: 'assistant',
    content,
    stopReason: (data && data.stop_reason) || 'end_turn',
    usage: data ? data.usage : undefined,
    model: data ? data.model : undefined,
    timestamp: Date.now(),
  };
}

/**
 * @param {Array<{ type: string, text?: string, value?: unknown }>} content
 * @returns {string}
 */
function toolResultContent(content) {
  const parts = [];
  for (const c of content || []) {
    if (!c) continue;
    if (c.type === 'text') parts.push(c.text || '');
    else if (c.type === 'json') parts.push(JSON.stringify(c.value));
    else parts.push(JSON.stringify(c));
  }
  return parts.join('\n');
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function stringifyContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return toolResultContent(content);
  return JSON.stringify(content);
}
