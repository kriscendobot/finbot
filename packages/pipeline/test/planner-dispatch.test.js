/**
 * Inference-driven DECIDE-stage (planner) dispatch tests.
 *
 * Companion to `role-dispatch.test.js` (ORIENT). Drives the DECIDE stage
 * end-to-end through `spawn` with the deterministic decide-phase tool, using
 * offline LLMs (the scripted planner double and the harness stub). Verifies the
 * stage completes, the subagent CALLS the deterministic `propose_rebalance`
 * planner, the hashed Proposal is extracted from the dispatch, and the
 * inference-driven path reproduces the headless planner's hash byte-for-byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '@finbot/harness/spawn';

import { plan } from '../planner.js';
import {
  dispatchPlanner, plannerBrief, makeScriptedPlannerLlm,
} from '../role-dispatch.js';

async function withFinbotRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-planner-dispatch-'));
  try {
    await mkdir(path.join(root, 'roles', 'planner'), { recursive: true });
    await writeFile(
      path.join(root, 'roles', 'planner', 'AGENT.md'),
      '# Role: planner\n\nEmit a ymax-shaped proposal; read-only; do not sign.\n',
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function decideInput() {
  return {
    portfolio: { cash: 1000, balances: { ATOM: 10 }, quoteCurrency: 'USDC' },
    prices: { ATOM: 9 },
    targetWeights: { ATOM: 0.6 },
    cited_forecasts: ['forecast:abc'],
    cited_analyses: ['analysis:def'],
  };
}

test('plannerBrief: embeds the target weights and instructs tool use', () => {
  const brief = plannerBrief(decideInput());
  assert.match(brief, /propose_rebalance/);
  assert.match(brief, /ATOM/);
  assert.match(brief, /read-only/);
  assert.match(brief, /cite at least one forecast/);
});

test('dispatchPlanner (scripted LLM): drives the decide stage end-to-end via the deterministic planner', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = decideInput();
    const dispatch = await dispatchPlanner(input, {
      spawn,
      finbotRoot,
      llm: makeScriptedPlannerLlm(input),
    });

    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('propose_rebalance'),
      'planner called the deterministic proposal tool');
    assert.equal(dispatch.proposed, true);
    assert.ok(dispatch.proposal, 'hashed Proposal was extracted');
    assert.ok(dispatch.proposal.steps.length > 0, 'a non-trivial rebalance was proposed');
    assert.deepEqual(dispatch.proposal.cited_forecasts, ['forecast:abc']);
    assert.match(dispatch.finalText, /hash=/);
  });
});

test('dispatchPlanner: the inference-driven hash reproduces the headless planner hash', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = decideInput();
    const headless = plan({
      portfolio: input.portfolio,
      prices: input.prices,
      targetWeights: input.targetWeights,
      cited_forecasts: input.cited_forecasts,
      cited_analyses: input.cited_analyses,
    });
    const dispatch = await dispatchPlanner(input, {
      spawn, finbotRoot, llm: makeScriptedPlannerLlm(input),
    });
    assert.equal(dispatch.proposal.proposal_hash, headless.proposal_hash,
      'the inference path and the headless path agree on the deterministic hash');
  });
});

test('dispatchPlanner (harness stub LLM): still completes and calls a deterministic tool offline', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const dispatch = await dispatchPlanner(decideInput(), { spawn, finbotRoot });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.length > 0, 'a deterministic tool was invoked');
  });
});

test('dispatchPlanner: requires the harness spawn function', async () => {
  await assert.rejects(() => dispatchPlanner(decideInput(), {}), /deps\.spawn/);
});

test('dispatchPlanner: an at-target portfolio proposes no steps without error', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // Portfolio already ~100% ATOM with a target of 100% ATOM -> no funds flow.
    const input = {
      portfolio: { cash: 0, balances: { ATOM: 100 }, quoteCurrency: 'USDC' },
      prices: { ATOM: 10 },
      targetWeights: { ATOM: 1 },
      cited_forecasts: ['forecast:x'],
      cited_analyses: ['analysis:y'],
    };
    const dispatch = await dispatchPlanner(input, { spawn, finbotRoot, llm: makeScriptedPlannerLlm(input) });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('propose_rebalance'));
    assert.equal(dispatch.proposal.steps.length, 0);
  });
});
