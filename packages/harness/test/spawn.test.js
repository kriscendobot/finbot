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
import { compartmentAttenuator, permissiveAttenuator, runCompartmentLlm } from '../sandbox/permissive.js';
import { toolResult } from '../schemas/tool.js';
import { assertSpawnParams, SpawnParamsError } from '../schemas/spawn.js';

test('assertSpawnParams: rejects missing role', () => {
  assert.throws(() => assertSpawnParams({ brief: 'hi' }), SpawnParamsError);
});

test('assertSpawnParams: accepts a minimal valid params object', () => {
  assert.doesNotThrow(() => assertSpawnParams({ role: 'planner', brief: 'plan something' }));
});

test('assertSpawnParams: rejects simultaneous host and compartment LLMs', () => {
  assert.throws(
    () => assertSpawnParams({ role: 'planner', brief: 'plan something', llm: () => {}, llmProgram: '() => ({})' }),
    SpawnParamsError,
  );
});

test('assertSpawnParams: rejects whitespace-only compartment programs', () => {
  assert.throws(
    () => assertSpawnParams({ role: 'planner', brief: 'plan something', llmProgram: ' \n\t ' }),
    SpawnParamsError,
  );
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
  assert.notEqual(result.globals.console, console);
  assert.equal(typeof result.globals.console.log, 'function');
  assert.equal(result.globals.fetch, undefined);
  assert.equal(Object.isFrozen(console), false);
  assert.equal(Object.isFrozen(fetch), false);
});

test('compartmentAttenuator: an explicit empty capability set vends no tools', () => {
  const result = compartmentAttenuator('planner', [], {
    tools: { harmless: { name: 'harmless' }, wallet: { name: 'wallet' } },
  });
  assert.deepEqual(Object.keys(result.tools), []);
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

test('spawn: retains host error stacks without returning tool diagnostics to a role', async () => {
  const hostDiagnostic = 'host-only diagnostic detail';
  const llm = async ({ turn, messages }) => {
    if (turn === 0) {
      return {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'failing-tool', name: 'failing', arguments: {} }],
        stopReason: 'tool_use',
      };
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: messages.at(-1).content[0].text }],
      stopReason: 'end_turn',
    };
  };
  const handle = await spawn(
    { role: 'planner', brief: 'go', llm },
    {
      tools: {
        failing: {
          name: 'failing',
          run: async () => {
            throw new Error(hostDiagnostic);
          },
        },
      },
    },
  );
  await handle.done;
  assert.equal(handle.status, 'completed');
  assert.equal(handle.result.finalText, 'tool execution failed');
  assert.doesNotMatch(handle.result.finalText, new RegExp(hostDiagnostic));
  const toolError = handle.events.find((event) => event.type === 'tool_execution_error');
  assert.match(toolError.error.stack, /host-only diagnostic detail/);

  const failedLlm = async () => {
    throw new Error(hostDiagnostic);
  };
  const failedHandle = await spawn({ role: 'planner', brief: 'go', llm: failedLlm }, { tools: {} });
  await failedHandle.done;
  assert.equal(failedHandle.status, 'errored');
  assert.match(failedHandle.error.stack, /host-only diagnostic detail/);
});

test('runCompartmentLlm: a role program cannot reach host authority', async () => {
  const message = await runCompartmentLlm({
    role: 'planner',
    source: '(input) => ({ role: "assistant", content: [{ type: "text", text: [typeof process, typeof require, typeof fetch, typeof globalThis.input, input.toolNames.join(",")].join("|") }], stopReason: "end_turn" })',
    input: { toolNames: ['propose_rebalance'] },
  });
  assert.equal(message.content[0].text, 'undefined|undefined|undefined|undefined|propose_rebalance');
});

test('runCompartmentLlm: normalizes a compartment assistant message to host transcript shape', async () => {
  const started = Date.now();
  const message = await runCompartmentLlm({
    role: 'planner',
    source: '() => ({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end_turn", timestamp: 0 })',
    input: {},
  });
  assert.equal(message.role, 'assistant');
  assert.equal(message.stopReason, 'end_turn');
  assert.equal(message.timestamp >= started, true);
  assert.notEqual(message.timestamp, 0);
  assert.equal(Object.isFrozen(message), true);
});

test('runCompartmentLlm: rejects non-function and invalid source', async () => {
  await assert.rejects(
    runCompartmentLlm({ role: 'planner', source: '({})', input: {} }),
    /must evaluate to a function/,
  );
  await assert.rejects(
    runCompartmentLlm({ role: 'planner', source: '(', input: {} }),
    /must be valid JavaScript/,
  );
});

test('runCompartmentLlm: reports non-serializable input and BigInt precisely', async () => {
  await assert.rejects(
    runCompartmentLlm({ role: 'planner', source: '(input) => input', input: { amount: 1n } }),
    /input must be JSON-serializable: BigInt is not supported by the JSON boundary/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    runCompartmentLlm({ role: 'planner', source: '(input) => input', input: cyclic }),
    /input must be JSON-serializable/,
  );
});

test('runCompartmentLlm: rejects malformed and accessor-shaped returns at the boundary', async () => {
  await assert.rejects(
    runCompartmentLlm({ role: 'planner', source: '() => ({ role: "system" })', input: {} }),
    /result.role must be "assistant"/,
  );
  await assert.rejects(
    runCompartmentLlm({
      role: 'planner',
      source: '() => ({ role: "assistant", get content() { return []; } })',
      input: {},
    }),
    /accessor property/,
  );
  await assert.rejects(
    runCompartmentLlm({
      role: 'planner',
      source: '() => new Proxy({}, { ownKeys() { throw Error("proxy trap"); } })',
      input: {},
    }),
    /result must be JSON-serializable: proxy trap/,
  );
});

test('runCompartmentLlm: terminates a non-yielding role program at the timeout', async () => {
  // Regression: a synchronous, non-yielding role program used to run on the
  // host event-loop thread via `await program(...)`, so it blocked the loop and
  // no `timeoutMs`/`Promise.race` deadline could ever fire — the call hung
  // forever. With the worker-thread runner the host stays free to terminate it.
  const started = Date.now();
  await assert.rejects(
    runCompartmentLlm({
      role: 'planner',
      source: '() => { while (true) {} }',
      input: {},
      timeoutMs: 250,
    }),
    /role program timed out after 250ms/,
  );
  // Preemption proof: we regained control near the deadline, nowhere near the
  // 10-minute default a blocked loop would have imposed.
  assert.ok(Date.now() - started < 8000, `expected prompt termination, took ${Date.now() - started}ms`);
});

test('runCompartmentLlm: a role program runs in an isolated worker realm', async () => {
  // The program cannot see host thread-locals; worker_threads gives it a fresh
  // V8 isolate, and the compartment inside it exposes only the role's globals.
  const message = await runCompartmentLlm({
    role: 'planner',
    source: '(input) => ({ role: "assistant", content: [{ type: "text", text: [typeof process, typeof Worker, typeof globalThis.parentPort, typeof console.log, typeof fetch].join("|") }], stopReason: "end_turn" })',
    input: {},
  });
  // planner policy grants console but not fetch; no worker/host ambient leaks in.
  assert.equal(message.content[0].text, 'undefined|undefined|undefined|function|undefined');
});

test('spawn: llmProgram runs inside a compartment and can request only vended tools', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-spawn-'));
  try {
    let toolRuns = 0;
    const tools = {
      allowed: {
        name: 'allowed',
        description: '',
        inputSchema: { type: 'object' },
        run: async () => {
          toolRuns += 1;
          return toolResult(true, [{ type: 'text', text: 'ok' }]);
        },
      },
      blocked: {
        name: 'blocked',
        description: '',
        inputSchema: { type: 'object' },
        run: async () => {
          throw new Error('blocked tool must not run');
        },
      },
    };
    const llmProgram = `(input) => input.turn === 0
      ? {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'compartment-tool-call', name: input.toolNames[0], arguments: {} }],
        stopReason: 'tool_use',
      }
      : {
        role: 'assistant',
        content: [{ type: 'text', text: [typeof process, input.toolNames.join(',')].join('|') }],
        stopReason: 'end_turn',
      }`;
    const handle = await spawn(
      { role: 'planner', brief: 'go', capabilities: ['allowed'], llmProgram },
      { finbotRoot: tmp, tools },
    );
    await handle.done;
    assert.equal(handle.status, 'completed');
    assert.equal(toolRuns, 1);
    assert.equal(handle.result.finalText, 'undefined|allowed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('spawn: an llmProgram without capability grants cannot acquire host tools by omission', async () => {
  let walletRuns = 0;
  const handle = await spawn(
    {
      role: 'planner',
      brief: 'go',
      llmProgram: `() => ({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'unexpected-wallet', name: 'wallet', arguments: {} }],
        stopReason: 'tool_use',
      })`,
    },
    {
      tools: {
        wallet: {
          name: 'wallet',
          run: async () => {
            walletRuns += 1;
            return toolResult(true, [{ type: 'text', text: 'must not run' }]);
          },
        },
      },
    },
  );
  await handle.done;
  assert.equal(walletRuns, 0);
  const toolEnd = handle.events.find((event) => event.type === 'tool_execution_end');
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content[0].text, /wallet not in subagent capability set/);
});

test('spawn: a custom attenuator is the sole source of a compartment program\'s globals', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'finbot-spawn-'));
  try {
    // This attenuator narrows the role's ambient globals to the empty set and
    // injects a distinctive marker. If the compartment path honors the
    // attenuator (the declared narrowing point being the sole one), the program
    // sees the marker and NOT the role's default `console`. If it re-derived the
    // policy from CAPABILITY_MAP behind the attenuator's back, it would still
    // see `console` and never the marker.
    const narrowingAttenuator = () => ({
      globals: { attenuatorMarker: 'narrowed' },
      modules: {},
      tools: {},
    });
    const llmProgram = `(input) => ({
      role: 'assistant',
      content: [{ type: 'text', text: [typeof console, typeof globalThis.attenuatorMarker].join('|') }],
      stopReason: 'end_turn',
    })`;
    const handle = await spawn(
      { role: 'planner', brief: 'go', llmProgram, attenuator: narrowingAttenuator },
      { finbotRoot: tmp, tools: {} },
    );
    await handle.done;
    assert.equal(handle.status, 'completed');
    assert.equal(handle.result.finalText, 'undefined|string');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('spawn: unavailable compartment-requested tool is returned as a tool error', async () => {
  const llmProgram = `() => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'missing-tool', name: 'missing', arguments: {} }],
    stopReason: 'tool_use',
  })`;
  const handle = await spawn(
    { role: 'planner', brief: 'go', llmProgram },
    { tools: {} },
  );
  await handle.done;
  assert.equal(handle.status, 'completed');
  const toolEnd = handle.events.find((event) => event.type === 'tool_execution_end');
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content[0].text, /missing not in subagent capability set/);
});
