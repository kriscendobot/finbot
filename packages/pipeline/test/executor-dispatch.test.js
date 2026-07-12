/**
 * Inference-driven ACT-stage (executor) dispatch tests — DRY-RUN.
 *
 * Companion to `role-dispatch.test.js` (ORIENT), `planner-dispatch.test.js`
 * (DECIDE), and `auditor-dispatch.test.js` (AUDIT). Drives the ACT stage's
 * executor half end-to-end through `spawn` with the deterministic dry-run
 * executor, using offline LLMs (the scripted executor double and the harness
 * stub). Verifies the stage completes, the subagent CALLS the deterministic
 * `simulate_execution` tool, the ExecutionResult is extracted from the
 * dispatch, the inference-driven dry-run reproduces the headless executor's
 * simulation byte-for-byte, a fire-time-audit rejection surfaces (not only the
 * happy path), and — the load-bearing safety property — the wallet is NEVER
 * touched: the executor tool is pinned to dry-run and vends no wallet, so no
 * capability path reaches a signer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '@finbot/harness/spawn';
import { makeWorld } from '@finbot/simulator/world';

import { plan } from '../planner.js';
import { execute } from '../executor.js';
import {
  dispatchExecutor, executorBrief, makeScriptedExecutorLlm,
} from '../role-dispatch.js';

async function withFinbotRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-executor-dispatch-'));
  try {
    await mkdir(path.join(root, 'roles', 'executor'), { recursive: true });
    await writeFile(
      path.join(root, 'roles', 'executor', 'AGENT.md'),
      '# Role: executor\n\nSimulate an approved proposal in dry-run; strictly read-only here — never touch a wallet.\n',
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A modest, in-bounds buy over a paper portfolio, plus a forecast whose p05
// clears the tail floor at fire time. The headless world and the dispatch input
// share the same pre-trade snapshot, so both paths simulate the same steps.
function setup() {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.01 }, drifts: { ATOM: 0 }, seed: 3 },
    seed: 3,
  });
  const prices = world.priceFeed.current();
  const snapshot = world.portfolio.markToMarket(prices);
  const proposal = plan({
    portfolio: snapshot,
    prices,
    targetWeights: { ATOM: 0.3 },
    bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
    cited_forecasts: ['f'],
    cited_analyses: ['a'],
  });
  const forecast = { p05Equity: 950, summary: { p05: 950, p50: 1000, p95: 1050 } };
  const currentTick = world.priceFeed.t;
  const auditConfig = { tailFloorPct: 0.8, maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 };
  const input = {
    proposal,
    portfolio: { cash: snapshot.cash, balances: snapshot.balances, quoteCurrency: 'USDC' },
    prices,
    forecast,
    currentTick,
    oracleReadings: [],
    config: auditConfig,
  };
  return { world, input, proposal, forecast, currentTick, auditConfig };
}

test('executorBrief: embeds the proposal and instructs dry-run, wallet-free tool use', () => {
  const brief = executorBrief(setup().input);
  assert.match(brief, /simulate_execution/);
  assert.match(brief, /DRY-RUN/);
  assert.match(brief, /never sign, send, or touch a wallet/);
  assert.match(brief, /walletTouched: false is the proof/);
});

test('dispatchExecutor (scripted LLM): drives the act stage end-to-end via the deterministic dry-run executor', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const { input } = setup();
    const dispatch = await dispatchExecutor(input, {
      spawn,
      finbotRoot,
      llm: makeScriptedExecutorLlm(input),
    });

    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('simulate_execution'),
      'executor called the deterministic dry-run executor');
    assert.equal(dispatch.executed, true);
    assert.ok(dispatch.execution, 'an ExecutionResult was extracted');
    assert.equal(dispatch.execution.mode, 'dry-run');
    assert.ok(dispatch.execution.steps_completed.length >= 1, 'at least one step simulated');
    assert.match(dispatch.finalText, /walletTouched=false/);
  });
});

test('dispatchExecutor: the wallet is NEVER touched (dry-run, no wallet vended)', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const { input } = setup();
    const dispatch = await dispatchExecutor(input, {
      spawn, finbotRoot, llm: makeScriptedExecutorLlm(input),
    });
    assert.equal(dispatch.walletTouched, false, 'the dispatch reports the wallet untouched');
    assert.equal(dispatch.execution.walletTouched, false, 'the ExecutionResult proves it');
    assert.equal(dispatch.execution.submission, null, 'nothing was submitted');
  });
});

test('dispatchExecutor: the inference-driven dry-run reproduces the headless executor', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const { world, input, proposal, forecast, currentTick, auditConfig } = setup();
    const headless = await execute(
      { proposal, world, forecast, oracleReadings: [], currentTick, parentCaps: {} },
      { mode: 'dry-run', auditConfig },
    );
    const dispatch = await dispatchExecutor(input, {
      spawn, finbotRoot, llm: makeScriptedExecutorLlm(input),
    });
    const got = dispatch.execution;

    assert.equal(headless.walletTouched, false);
    assert.equal(got.walletTouched, false);
    assert.equal(got.proposal_hash, proposal.proposal_hash);
    assert.equal(got.fire_time_audit.verdict, headless.fire_time_audit.verdict,
      'the fire-time drift-guard verdict agrees');
    assert.deepEqual(got.steps_completed, headless.steps_completed,
      'the simulated steps agree byte-for-byte');
    assert.deepEqual(got.post_execution_balances, headless.post_execution_balances,
      'the post-execution balances agree');
    assert.equal(got.substrate, headless.substrate, 'the target substrate agrees');
    assert.deepEqual(got.prepared_transaction, headless.prepared_transaction,
      'the would-be substrate transaction agrees');
  });
});

test('dispatchExecutor: a fire-time-audit rejection surfaces (no steps, wallet still untouched)', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const { input } = setup();
    // A tail floor far above the forecast p05 forces the fire-time audit to
    // reject at execution time (drift guard), so no steps simulate — proving
    // the inference path surfaces a fire-time rejection, not only a happy path.
    input.config = { tailFloorPct: 5 };
    const dispatch = await dispatchExecutor(input, {
      spawn, finbotRoot, llm: makeScriptedExecutorLlm(input),
    });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('simulate_execution'));
    assert.equal(dispatch.execution.fire_time_audit.verdict, 'rejected');
    assert.ok(dispatch.execution.fire_time_audit.failed_invariants.includes('tail-risk-floor'));
    assert.equal(dispatch.execution.steps_completed.length, 0, 'no steps on a rejected drift guard');
    assert.equal(dispatch.walletTouched, false, 'wallet untouched even on rejection');
  });
});

test('dispatchExecutor (harness stub LLM): still completes and calls a deterministic tool offline', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const dispatch = await dispatchExecutor(setup().input, { spawn, finbotRoot });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.length > 0, 'a deterministic tool was invoked');
  });
});

test('dispatchExecutor: requires the harness spawn function', async () => {
  await assert.rejects(() => dispatchExecutor(setup().input, {}), /deps\.spawn/);
});
