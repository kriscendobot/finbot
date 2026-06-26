/**
 * Pipeline-as-tools tests.
 *
 * The deterministic orient functions, wrapped as harness tools, must (a) be
 * valid tool definitions and (b) produce the same structured output as calling
 * the underlying function directly. Offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertToolDef } from '@finbot/harness/schemas';

import { pipelineToolRegistry, PIPELINE_TOOL_NAMES } from '../agent-tools.js';
import { observeOpportunities } from '../oracle-watcher.js';
import { analyze } from '../analyzer.js';

function readings(seq, asset = 'ATOM', startTick = 0) {
  return seq.map((p, i) => ({ t: startTick + i, prices: { [asset]: p } }));
}

test('pipelineToolRegistry: exposes the named orient tools, all valid', () => {
  const registry = pipelineToolRegistry();
  assert.deepEqual(Object.keys(registry).sort(), [...PIPELINE_TOOL_NAMES].sort());
  for (const tool of Object.values(registry)) assert.doesNotThrow(() => assertToolDef(tool));
});

test('score_opportunities tool: matches direct analyze() output on a dip', async () => {
  const r = readings([10, 9.5, 9.0]);
  const opportunities = observeOpportunities({ readings: r }, { thresholdBps: 50 }).crossings;
  const portfolio = { cash: 1000, balances: { ATOM: 10 } };
  const prices = { ATOM: 9 };

  const direct = analyze({ opportunities, readings: r, portfolio, prices }, { scoreFloor: 0 });

  const tool = pipelineToolRegistry().score_opportunities;
  const result = await tool.run({ opportunities, readings: r, portfolio, prices, config: { scoreFloor: 0 } });

  assert.equal(result.ok, true);
  const jsonBlock = result.content.find((c) => c.type === 'json');
  assert.ok(jsonBlock, 'tool result carries a json block');
  assert.equal(jsonBlock.value.next_action, 'propose-rebalance');
  assert.deepEqual(jsonBlock.value.targetWeights, direct.targetWeights);
});

test('realized_volatility tool: returns a positive vol for a moving series', async () => {
  const tool = pipelineToolRegistry().realized_volatility;
  const result = await tool.run({ readings: readings([10, 10.5, 9.8, 10.2]), asset: 'ATOM' });
  assert.equal(result.ok, true);
  const jsonBlock = result.content.find((c) => c.type === 'json');
  assert.ok(jsonBlock.value.volatility > 0);
});

test('observe_opportunities tool: surfaces a crossing past threshold', async () => {
  const tool = pipelineToolRegistry().observe_opportunities;
  const result = await tool.run({ readings: readings([10, 10.1, 10.6]), thresholdBps: 50 });
  assert.equal(result.ok, true);
  const jsonBlock = result.content.find((c) => c.type === 'json');
  assert.equal(jsonBlock.value.crossings.length, 1);
  assert.equal(jsonBlock.value.crossings[0].asset, 'ATOM');
});

test('score_opportunities tool: empty inputs degrade to no-action, not an error', async () => {
  const tool = pipelineToolRegistry().score_opportunities;
  const result = await tool.run({ opportunities: [], readings: [], portfolio: { cash: 0, balances: {} } });
  assert.equal(result.ok, true);
  const jsonBlock = result.content.find((c) => c.type === 'json');
  assert.equal(jsonBlock.value.next_action, 'no-action');
});
