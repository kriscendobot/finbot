/**
 * Inference-driven role-dispatch tests.
 *
 * Drives the ORIENT stage end-to-end through `spawn` with the deterministic
 * pipeline tools, using offline LLMs (the scripted analyzer double and the
 * harness stub). Verifies the stage completes, the subagent CALLS the
 * deterministic scorer, and the scored AnalyzerResult is extracted from the
 * dispatch — the "Done" criterion: an inference-driven role dispatch that
 * drives one OODA stage end-to-end in dry-run with the deterministic pipeline
 * functions available as tools, green offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '@finbot/harness/spawn';

import { observeOpportunities } from '../oracle-watcher.js';
import {
  dispatchAnalyzer, analyzerBrief, makeScriptedAnalyzerLlm,
} from '../role-dispatch.js';

function readings(seq, asset = 'ATOM', startTick = 0) {
  return seq.map((p, i) => ({ t: startTick + i, prices: { [asset]: p } }));
}

async function withFinbotRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-dispatch-'));
  try {
    await mkdir(path.join(root, 'roles', 'analyzer'), { recursive: true });
    await writeFile(
      path.join(root, 'roles', 'analyzer', 'AGENT.md'),
      '# Role: analyzer\n\nScore opportunities; read-only; no-action is valid.\n',
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function dipInput() {
  const r = readings([10, 9.5, 9.0]);
  const opportunities = observeOpportunities({ readings: r }, { thresholdBps: 50 }).crossings;
  return {
    opportunities,
    readings: r,
    portfolio: { cash: 1000, balances: { ATOM: 10 } },
    prices: { ATOM: 9 },
    analyzerConfig: { scoreFloor: 0 },
  };
}

test('analyzerBrief: embeds the opportunities and instructs tool use', () => {
  const brief = analyzerBrief(dipInput());
  assert.match(brief, /score_opportunities/);
  assert.match(brief, /ATOM/);
  assert.match(brief, /read-only/);
});

test('dispatchAnalyzer (scripted LLM): drives the orient stage end-to-end via the deterministic scorer', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = dipInput();
    const dispatch = await dispatchAnalyzer(input, {
      spawn,
      finbotRoot,
      llm: makeScriptedAnalyzerLlm(input),
    });

    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('score_opportunities'),
      'analyzer called the deterministic scorer');
    assert.equal(dispatch.scored, true);
    assert.ok(dispatch.analysis, 'scored AnalyzerResult was extracted');
    assert.equal(dispatch.analysis.next_action, 'propose-rebalance');
    assert.ok(dispatch.analysis.targetWeights.ATOM > 0);
    assert.match(dispatch.finalText, /propose-rebalance/);
  });
});

test('dispatchAnalyzer (harness stub LLM): still completes and calls a deterministic tool offline', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // No llm injected -> spawn uses its deterministic stub, which calls the
    // first available tool. The stage completes offline without a provider.
    const dispatch = await dispatchAnalyzer(dipInput(), { spawn, finbotRoot });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.length > 0, 'a deterministic tool was invoked');
  });
});

test('dispatchAnalyzer: requires the harness spawn function', async () => {
  await assert.rejects(() => dispatchAnalyzer(dipInput(), {}), /deps\.spawn/);
});

test('dispatchAnalyzer: a quiet window scores no-action without error', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const r = readings([10, 10.01, 10.0]);
    const input = {
      opportunities: observeOpportunities({ readings: r }, { thresholdBps: 50 }).crossings,
      readings: r,
      portfolio: { cash: 1000, balances: { ATOM: 10 } },
      prices: { ATOM: 10 },
      analyzerConfig: { scoreFloor: 0 },
    };
    const dispatch = await dispatchAnalyzer(input, { spawn, finbotRoot, llm: makeScriptedAnalyzerLlm(input) });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('score_opportunities'));
    assert.equal(dispatch.analysis.next_action, 'no-action');
  });
});
