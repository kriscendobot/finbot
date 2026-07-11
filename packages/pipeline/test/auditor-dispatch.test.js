/**
 * Inference-driven AUDIT-stage (auditor) dispatch tests.
 *
 * Companion to `role-dispatch.test.js` (ORIENT) and `planner-dispatch.test.js`
 * (DECIDE). Drives the AUDIT stage end-to-end through `spawn` with the
 * deterministic audit-phase gate, using offline LLMs (the scripted auditor
 * double and the harness stub). Verifies the stage completes, the subagent
 * CALLS the deterministic `audit_proposal` gate, the AuditVerdict is extracted
 * from the dispatch, the inference-driven path reproduces the headless
 * auditor's verdict byte-for-byte, and a bound-busting proposal is rejected via
 * the same gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawn } from '@finbot/harness/spawn';

import { plan } from '../planner.js';
import { audit } from '../auditor.js';
import {
  dispatchAuditor, auditorBrief, makeScriptedAuditorLlm,
} from '../role-dispatch.js';

async function withFinbotRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-auditor-dispatch-'));
  try {
    await mkdir(path.join(root, 'roles', 'auditor'), { recursive: true });
    await writeFile(
      path.join(root, 'roles', 'auditor', 'AGENT.md'),
      '# Role: auditor\n\nAdjudicate a proposal against the invariant set; read-only; the gate, not an authorization.\n',
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A modest, in-bounds proposal over a paper portfolio, plus a forecast whose
// p05 clears the tail floor and readings fresh against the current tick.
function auditInput() {
  const portfolio = { cash: 1000, balances: { ATOM: 10 }, quoteCurrency: 'USDC' };
  const prices = { ATOM: 9 };
  const proposal = plan({
    portfolio,
    prices,
    targetWeights: { ATOM: 0.6 },
    cited_forecasts: ['forecast:abc'],
    cited_analyses: ['analysis:def'],
  });
  return {
    proposal,
    forecast: { p05Equity: 1090, summary: {}, ensembleSize: 64, horizon: 12, currentNav: 1090 },
    portfolio,
    prices,
    currentTick: 12,
    oracleReadings: [{ asset: 'ATOM', observedAtTick: 11, deviationBps: -100, direction: 'down' }],
  };
}

test('auditorBrief: embeds the proposal and instructs gate use', () => {
  const brief = auditorBrief(auditInput());
  assert.match(brief, /audit_proposal/);
  assert.match(brief, /read-only/);
  assert.match(brief, /precondition for execution/);
  assert.match(brief, /never an authorization/);
});

test('dispatchAuditor (scripted LLM): drives the audit stage end-to-end via the deterministic gate', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = auditInput();
    const dispatch = await dispatchAuditor(input, {
      spawn,
      finbotRoot,
      llm: makeScriptedAuditorLlm(input),
    });

    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('audit_proposal'),
      'auditor called the deterministic audit gate');
    assert.equal(dispatch.adjudicated, true);
    assert.ok(dispatch.verdict, 'an AuditVerdict was extracted');
    assert.equal(dispatch.verdict.verdict, 'approved');
    assert.equal(dispatch.verdict.proposal_hash, input.proposal.proposal_hash);
    assert.match(dispatch.finalText, /verdict=approved/);
  });
});

test('dispatchAuditor: the inference-driven verdict reproduces the headless auditor verdict', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = auditInput();
    const headless = audit(
      {
        proposal: input.proposal,
        forecast: input.forecast,
        portfolio: input.portfolio,
        prices: input.prices,
        currentTick: input.currentTick,
        oracleReadings: input.oracleReadings,
      },
      {},
    );
    const dispatch = await dispatchAuditor(input, {
      spawn, finbotRoot, llm: makeScriptedAuditorLlm(input),
    });
    assert.deepEqual(dispatch.verdict, headless,
      'the inference path and the headless path agree on the full verdict');
  });
});

test('dispatchAuditor: a bound-busting proposal is REJECTED through the same gate', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const input = auditInput();
    // A tail floor above the forecast p05 forces the tail-risk-floor invariant
    // to fail, so the gate rejects — proving the inference path surfaces a
    // rejection, not only an approval.
    input.config = { tailFloorPct: 5 };
    const dispatch = await dispatchAuditor(input, {
      spawn, finbotRoot, llm: makeScriptedAuditorLlm(input),
    });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.includes('audit_proposal'));
    assert.equal(dispatch.verdict.verdict, 'rejected');
    assert.ok(dispatch.verdict.failed_invariants.includes('tail-risk-floor'));
    assert.match(dispatch.finalText, /verdict=rejected/);
  });
});

test('dispatchAuditor (harness stub LLM): still completes and calls a deterministic tool offline', async () => {
  await withFinbotRoot(async (finbotRoot) => {
    const dispatch = await dispatchAuditor(auditInput(), { spawn, finbotRoot });
    assert.equal(dispatch.status, 'completed');
    assert.ok(dispatch.toolCalls.length > 0, 'a deterministic tool was invoked');
  });
});

test('dispatchAuditor: requires the harness spawn function', async () => {
  await assert.rejects(() => dispatchAuditor(auditInput(), {}), /deps\.spawn/);
});
