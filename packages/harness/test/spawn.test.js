/**
 * Subagent spawn tests.
 *
 * Verifies:
 *   - spawn returns a handle with an events array
 *   - capability attenuation restricts available tools
 *   - tool calls produced by the stub LLM are executed
 *   - the handle's done promise resolves
 *   - missing role file is tolerated (soft default brief)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '../spawn.js';
import { compartmentAttenuator, permissiveAttenuator } from '../sandbox/permissive.js';
import { toolResult } from '../schemas/tool.js';
import { assertSpawnParams, SpawnParamsError } from '../schemas/spawn.js';

test('assertSpawnParams: rejects missing role', () => {
  assert.throws(() => assertSpawnParams({ brief: 'hi' }), SpawnParamsError);
});

test('assertSpawnParams: accepts a minimal valid params object', () => {
  assert.doesNotThrow(() => assertSpawnParams({ role: 'planner', brief: 'plan something' }));
});

test('permissiveAttenuator: returns capability subset', () => {
  const tools = { a: { name: 'a' }, b: { name: 'b' }, c: { name: 'c' } };
  const r = permissiveAttenuator('planner', ['a', 'c'], { tools });
  assert.deepEqual(Object.keys(r.tools).sort(), ['a', 'c']);
});

test('permissiveAttenuator: empty capabilities returns all tools', () => {
  const tools = { a: { name: 'a' }, b: { name: 'b' } };
  const r = permissiveAttenuator('planner', [], { tools });
  assert.deepEqual(Object.keys(r.tools).sort(), ['a', 'b']);
});

test('compartmentAttenuator: returns a hardened role policy and capability subset', () => {
  const tools = { a: { name: 'a' }, b: { name: 'b' } };
  const result = compartmentAttenuator('planner', ['a'], { tools });
  assert.deepEqual(Object.keys(result.tools), ['a']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.globals), true);
  assert.equal(Object.isFrozen(result.tools), true);
  assert.equal(result.globals.console, console);
  assert.equal(result.globals.fetch, undefined);
});

test('spawn: stub LLM invokes the first tool and completes', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-spawn-'));
  try {
    await mkdir(path.join(tmp, 'roles', 'planner'), { recursive: true });
    await writeFile(path.join(tmp, 'roles', 'planner', 'AGENT.md'), '# Planner role\n');
    let invokedTool = null;
    const tools = {
      hello: {
        name: 'hello',
        description: 'a test tool',
        inputSchema: { type: 'object' },
        run: async (args) => {
          invokedTool = { args };
          return toolResult(true, [{ type: 'text', text: 'hello back' }]);
        },
      },
    };
    const handle = await spawn({ role: 'planner', brief: 'do the thing' }, { finbotRoot: tmp, tools });
    await handle.done;
    assert.equal(handle.status, 'completed');
    assert.ok(invokedTool, 'tool should have been invoked');
    assert.equal(invokedTool.args.brief, 'do the thing');
    // event stream contains start + tool execution
    const types = handle.events.map((e) => e.type);
    assert.ok(types.includes('agent_start'));
    assert.ok(types.includes('tool_execution_start'));
    assert.ok(types.includes('tool_execution_end'));
    assert.ok(types.includes('agent_end'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('spawn: missing role file is tolerated', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-spawn-'));
  try {
    const tools = {
      noop: {
        name: 'noop',
        description: 'noop',
        inputSchema: { type: 'object' },
        run: async () => toolResult(true, [{ type: 'text', text: 'ok' }]),
      },
    };
    const handle = await spawn({ role: 'planner', brief: 'go' }, { finbotRoot: tmp, tools });
    await handle.done;
    assert.equal(handle.status, 'completed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('spawn: custom llm controls turn behavior', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-spawn-'));
  try {
    const tools = {
      x: {
        name: 'x',
        description: 'x',
        inputSchema: { type: 'object' },
        run: async () => toolResult(true, [{ type: 'text', text: 'x-result' }]),
      },
    };
    const customLlm = async ({ turn }) => {
      if (turn === 0) {
        return {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'toolCall', id: 't1', name: 'x', arguments: {} },
          ],
          stopReason: 'tool_use',
          timestamp: Date.now(),
        };
      }
      return {
        role: 'assistant',
        content: [{ type: 'text', text: 'done thinking' }],
        stopReason: 'end_turn',
        timestamp: Date.now(),
      };
    };
    const handle = await spawn({ role: 'planner', brief: 'go', llm: customLlm }, { finbotRoot: tmp, tools });
    await handle.done;
    assert.equal(handle.status, 'completed');
    assert.equal(handle.result.finalText, 'done thinking');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('spawn: capability subset blocks unauthorized tool', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-spawn-'));
  try {
    const tools = {
      allowed: { name: 'allowed', description: '', inputSchema: { type: 'object' }, run: async () => toolResult(true, [{ type: 'text', text: 'ok' }]) },
      blocked: { name: 'blocked', description: '', inputSchema: { type: 'object' }, run: async () => toolResult(true, [{ type: 'text', text: 'should not run' }]) },
    };
    const llm = async ({ turn }) => {
      if (turn === 0) {
        return {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'blocked', arguments: {} }],
          stopReason: 'tool_use',
          timestamp: Date.now(),
        };
      }
      return { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', timestamp: Date.now() };
    };
    const handle = await spawn(
      { role: 'planner', brief: 'go', capabilities: ['allowed'], llm },
      { finbotRoot: tmp, tools },
    );
    await handle.done;
    const toolEnd = handle.events.find((e) => e.type === 'tool_execution_end');
    assert.equal(toolEnd.result.isError, true);
    assert.match(toolEnd.result.content[0].text, /not in subagent capability set/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
