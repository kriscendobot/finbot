/**
 * Anthropic provider tests.
 *
 * All offline: the translation functions are pure, and the one end-to-end test
 * injects a fake `fetch` so no socket or API key is needed. Verifies:
 *   - harness messages translate to the Messages API shape (incl. tool_use / tool_result)
 *   - the harness tool registry renders to the Anthropic tool list
 *   - an Anthropic response translates back to a harness assistant message
 *   - makeAnthropicLlm posts the right body and returns a harness message
 *   - makeAnthropicLlm without a key throws a clear, offline-friendly error
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeAnthropicLlm, toAnthropicMessages, toAnthropicToolList, fromAnthropicResponse,
} from '../providers/anthropic.js';

test('toAnthropicMessages: user string passes through', () => {
  const out = toAnthropicMessages([{ role: 'user', content: 'hello' }]);
  assert.deepEqual(out, [{ role: 'user', content: 'hello' }]);
});

test('toAnthropicMessages: assistant text + toolCall -> text + tool_use', () => {
  const out = toAnthropicMessages([{
    role: 'assistant',
    content: [
      { type: 'text', text: 'thinking' },
      { type: 'toolCall', id: 't1', name: 'score', arguments: { a: 1 } },
    ],
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.deepEqual(out[0].content, [
    { type: 'text', text: 'thinking' },
    { type: 'tool_use', id: 't1', name: 'score', input: { a: 1 } },
  ]);
});

test('toAnthropicMessages: empty assistant content gets a placeholder block', () => {
  const out = toAnthropicMessages([{ role: 'assistant', content: [] }]);
  assert.equal(out[0].content.length, 1);
  assert.equal(out[0].content[0].type, 'text');
});

test('toAnthropicMessages: toolResult -> user tool_result with stringified json', () => {
  const out = toAnthropicMessages([{
    role: 'toolResult',
    toolCallId: 't1',
    content: [{ type: 'json', value: { next_action: 'no-action' } }, { type: 'text', text: 'ok' }],
    isError: false,
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  const block = out[0].content[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 't1');
  assert.equal(block.is_error, false);
  assert.match(block.content, /no-action/);
  assert.match(block.content, /ok/);
});

test('toAnthropicToolList: registry -> Anthropic tool list', () => {
  const registry = {
    score: { name: 'score', description: 'd', inputSchema: { type: 'object' } },
  };
  const list = toAnthropicToolList(registry);
  assert.deepEqual(list, [{ name: 'score', description: 'd', input_schema: { type: 'object' } }]);
});

test('toAnthropicToolList: undefined -> empty', () => {
  assert.deepEqual(toAnthropicToolList(undefined), []);
});

test('fromAnthropicResponse: text + tool_use -> harness assistant message', () => {
  const msg = fromAnthropicResponse({
    content: [
      { type: 'text', text: 'reasoning' },
      { type: 'tool_use', id: 'tu1', name: 'score', input: { x: 2 } },
      { type: 'thinking', thinking: '' },
    ],
    stop_reason: 'tool_use',
    model: 'claude-opus-4-8',
  });
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.stopReason, 'tool_use');
  assert.deepEqual(msg.content[0], { type: 'text', text: 'reasoning' });
  assert.deepEqual(msg.content[1], { type: 'toolCall', id: 'tu1', name: 'score', arguments: { x: 2 } });
  // empty thinking block dropped
  assert.equal(msg.content.length, 2);
});

test('fromAnthropicResponse: empty content yields a single empty text block', () => {
  const msg = fromAnthropicResponse({ content: [], stop_reason: 'end_turn' });
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'text');
});

test('makeAnthropicLlm: posts a well-formed body and returns a harness message', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tu9', name: 'score_opportunities', input: { ok: true } }],
        stop_reason: 'tool_use',
        model: 'claude-opus-4-8',
      }),
    };
  };
  const llm = makeAnthropicLlm({ apiKey: 'test-key', fetch: fakeFetch, model: 'claude-opus-4-8' });
  const msg = await llm({
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'go' }],
    tools: { score_opportunities: { name: 'score_opportunities', description: 'd', inputSchema: { type: 'object' } } },
  });

  // request shape
  assert.match(captured.url, /\/v1\/messages$/);
  assert.equal(captured.init.headers['x-api-key'], 'test-key');
  assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.body.model, 'claude-opus-4-8');
  assert.equal(captured.body.system, 'sys');
  assert.equal(captured.body.tools.length, 1);
  assert.equal(captured.body.tools[0].name, 'score_opportunities');
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'go' }]);

  // response translation
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content[0].type, 'toolCall');
  assert.equal(msg.content[0].name, 'score_opportunities');
});

test('makeAnthropicLlm: omits tools when registry empty', async () => {
  let body = null;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }) };
  };
  const llm = makeAnthropicLlm({ apiKey: 'k', fetch: fakeFetch });
  await llm({ systemPrompt: 's', messages: [{ role: 'user', content: 'go' }], tools: {} });
  assert.equal(body.tools, undefined);
});

test('makeAnthropicLlm: surfaces a non-ok HTTP response as an error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'slow down' });
  const llm = makeAnthropicLlm({ apiKey: 'k', fetch: fakeFetch });
  await assert.rejects(
    () => llm({ systemPrompt: 's', messages: [{ role: 'user', content: 'go' }], tools: {} }),
    /HTTP 429/,
  );
});

test('makeAnthropicLlm: throws a clear error when no API key is configured', async () => {
  const llm = makeAnthropicLlm({ apiKey: '', fetch: async () => { throw new Error('should not be called'); } });
  await assert.rejects(
    () => llm({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], tools: {} }),
    /no API key/,
  );
});
