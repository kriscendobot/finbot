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

import { pipelineToolRegistry, PIPELINE_TOOL_NAMES, observerToolRegistry } from '../agent-tools.js';
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

test('pipelineToolRegistry: retains the caller-parameterized observer compatibility tool', async () => {
  const tool = pipelineToolRegistry().observe_opportunities;
  const result = await tool.run({ readings: readings([10, 9.5, 9]), thresholdBps: 50 });
  const jsonBlock = result.content.find((c) => c.type === 'json');
  assert.equal(jsonBlock.value.crossings.length, 1);
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

test('observe_opportunities tool: uses its dispatch-bound input', async () => {
  const tool = observerToolRegistry({ readings: readings([10, 10.1, 10.6]), thresholdBps: 50 })
    .observe_opportunities;
  const result = await tool.run({});
  assert.equal(result.ok, true);
  const jsonBlock = result.content.find((c) => c.type === 'json');
  assert.equal(jsonBlock.value.crossings.length, 1);
  assert.equal(jsonBlock.value.crossings[0].asset, 'ATOM');
});

test('observerToolRegistry: requires trusted dispatch input', () => {
  assert.throws(() => observerToolRegistry(), /dispatch-bound trusted input/);
});

test('observe_opportunities tool: deduplicates a trusted asset allowlist', async () => {
  const tool = observerToolRegistry({
    readings: readings([10, 9.5, 9]), thresholdBps: 50, assets: ['ATOM', 'ATOM'],
  }).observe_opportunities;
  const result = await tool.run({});
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

// A tool `run` must convert a downstream throw into a structured `ok: false`
// result. If the exception escaped, it would unwind the dispatch loop instead
// of being reported back to the model as a failed tool call; these exercise
// each tool's error boundary with an input that makes the underlying
// deterministic function throw.

test('observe_opportunities tool: a malformed bound window surfaces as a structured failure', async () => {
  // Last reading has no `prices`, so the detector throws while resolving the
  // asset set. The bound tool must catch and report, not throw.
  const tool = observerToolRegistry({
    readings: [{ t: 0, prices: { ATOM: 1 } }, { t: 1 }], thresholdBps: 50,
  }).observe_opportunities;
  const result = await tool.run({});
  assert.equal(result.ok, false);
  const text = result.content.find((c) => c.type === 'text');
  assert.match(text.text, /^observe_opportunities failed:/);
});

test('observe_opportunities compat tool: a malformed window surfaces as a structured failure', async () => {
  // The caller-parameterized compatibility tool shares the same error boundary
  // as the bound one: a downstream throw must become a structured failure.
  const tool = pipelineToolRegistry().observe_opportunities;
  const result = await tool.run({ readings: [{ t: 0, prices: { ATOM: 1 } }, { t: 1 }] });
  assert.equal(result.ok, false);
  const text = result.content.find((c) => c.type === 'text');
  assert.match(text.text, /^observe_opportunities failed:/);
});

test('realized_volatility tool: a reading without a price book surfaces as a structured failure', async () => {
  const tool = pipelineToolRegistry().realized_volatility;
  const result = await tool.run({ readings: [{ t: 0 }, { t: 1 }], asset: 'ATOM' });
  assert.equal(result.ok, false);
  const text = result.content.find((c) => c.type === 'text');
  assert.match(text.text, /^realized_volatility failed:/);
});

test('score_opportunities tool: a reading without a price book surfaces as a structured failure', async () => {
  const tool = pipelineToolRegistry().score_opportunities;
  const result = await tool.run({
    opportunities: [{ asset: 'ATOM', deviationBps: 100, direction: 'down' }],
    readings: [{ t: 0 }, { t: 1 }],
    portfolio: { cash: 1000, balances: { ATOM: 1 } },
  });
  assert.equal(result.ok, false);
  const text = result.content.find((c) => c.type === 'text');
  assert.match(text.text, /^score_opportunities failed:/);
});
