/**
 * Inference-driven OBSERVE-stage (oracle-watcher) dispatch tests.
 *
 * Companion to `role-dispatch.test.js` (ORIENT), `planner-dispatch.test.js`
 * (DECIDE), `auditor-dispatch.test.js` and `executor-dispatch.test.js` (ACT).
 * Drives the OBSERVE stage end-to-end through `spawn` with the deterministic
 * observe-phase detector, using offline LLMs (the scripted observer double and
 * the harness stub). Verifies the stage completes, the subagent CALLS the
 * deterministic `observe_opportunities` tool, the observation is extracted from
 * the dispatch, the inference-driven path reproduces the headless
 * `observeOpportunities` crossings byte-for-byte, and a quiet window (no
 * crossing) is surfaced as zero crossings through the same tool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '@finbot/harness/spawn';

import { observeOpportunities } from '../oracle-watcher.js';
import {
  dispatchObserver, observeBrief, makeScriptedObserverLlm, lastObservationResult,
} from '../role-dispatch.js';

async function withFinbotRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-observe-dispatch-'));
  try {
    await mkdir(path.join(root, 'roles', 'oracle-watcher'), { recursive: true });
    await writeFile(
      path.join(root, 'roles', 'oracle-watcher', 'AGENT.md'),
      '# Role: oracle-watcher\n\nRead a price window and emit opportunity-deviation events; read-only; you never trade.\n',
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A window whose ATOM price drifts down ~150bps from the reference, so at a
// 50bps threshold exactly one crossing is emitted (ATOM, down).
function observeInput(thresholdBps = 50) {
  return {
    readings: [
      { t: 0, prices: { ATOM: 10, OSMO: 2 } },
      { t: 1, prices: { ATOM: 9.9, OSMO: 2 } },
      { t: 2, prices: { ATOM: 9.85, OSMO: 2 } },
    ],
    thresholdBps,
  };
}

test('observeBrief: embeds the window and instructs detector use', () => {
  const brief = observeBrief(observeInput());
  assert.match(brief, /observe_opportunities/);
  assert.match(brief, /read-only/);
  assert.match(brief, /OBSERVE phase/);
  assert.match(brief, /never score, propose, or trade/);
});

test('dispatchObserver (scripted LLM): drives the observe stage end-to-end via the deterministic detector', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput();
    const dispatch = await dispatchObserver(input, {
      spawn,
      finbotRoot,
      llm: makeScriptedObserverLlm(input),
    });

    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('observe_opportunities'),
      'observer called the deterministic detector');
    assert.equal(dispatch.observed, true);
    assert.ok(dispatch.observation, 'an observation was extracted');
    assert.equal(dispatch.crossings.length, 1);
    assert.equal(dispatch.crossings[0].asset, 'ATOM');
    assert.equal(dispatch.crossings[0].direction, 'down');
    assert.match(dispatch.finalText, /1 crossing/);
    assert.match(dispatch.finalText, /ATOM down/);
  });
});

test('dispatchObserver: the inference-driven crossings reproduce the headless observation', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = observeInput();
    const headless = observeOpportunities({ readings: input.readings }, { thresholdBps: input.thresholdBps });
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.deepEqual(dispatch.observation, headless,
      'the inference path and the headless path agree on the full observation');
  });
});

test('dispatchObserver: a quiet window surfaces zero crossings through the same tool', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    // A 300bps threshold is above the ~150bps ATOM move, so nothing crosses.
    const input = observeInput(300);
    const dispatch = await dispatchObserver(input, {
      spawn, finbotRoot, llm: makeScriptedObserverLlm(input),
    });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('observe_opportunities'));
    assert.equal(dispatch.observed, true);
    assert.equal(dispatch.crossings.length, 0);
    assert.match(dispatch.finalText, /0 crossing/);
  });
});

test('dispatchObserver (harness stub LLM): still completes and calls a deterministic tool offline', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const dispatch = await dispatchObserver(observeInput(), { spawn, finbotRoot });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.length > 0, 'a deterministic tool was invoked');
  });
});

test('lastObservationResult: returns null when no observe_opportunities call is present', () => {
  assert.equal(lastObservationResult([]), null);
  assert.equal(lastObservationResult([{ type: 'tool_execution_end', toolCall: { name: 'score_opportunities' }, result: {} }]), null);
});

test('dispatchObserver: requires the harness spawn function', async () => {
  await assert.rejects(() => dispatchObserver(observeInput(), {}), /deps\.spawn/);
});
