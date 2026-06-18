import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reflect, renderReflection, reflectAndRecord } from '../self-improvement.js';

function fakeObs(t, equity, opts = {}) {
  return {
    t,
    portfolio: {
      cash: opts.cash != null ? opts.cash : equity,
      balances: {},
      equity,
      realizedPnL: opts.realizedPnL || 0,
      unrealizedPnL: 0,
      totalPnL: opts.totalPnL || 0,
      costBasis: 0,
      tradeCount: opts.tradeCount || 0,
    },
  };
}

test('reflect: empty observations returns empty proposals', () => {
  const { proposals } = reflect({ observations: [] });
  assert.deepEqual(proposals, []);
});

test('reflect: negative P&L triggers momentum weight reduction', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 95), fakeObs(2, 90)];
  const r = reflect({
    observations: obs,
    harnessConfig: { weights: { momentum: 0.5 } },
  });
  const momentumProposal = r.proposals.find((p) => p.target === 'weights.momentum');
  assert.ok(momentumProposal);
  assert.equal(momentumProposal.from, 0.5);
  assert.ok(momentumProposal.to < 0.5);
});

test('reflect: high drawdown triggers stop tightening', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 150), fakeObs(2, 100)]; // 33% drawdown
  const r = reflect({
    observations: obs,
    harnessConfig: { drawdownStopPct: 0.20 },
  });
  const stopProposal = r.proposals.find((p) => p.target === 'drawdownStopPct');
  assert.ok(stopProposal);
  assert.ok(stopProposal.to < 0.20);
});

test('reflect: zero trades triggers propose-threshold lowering', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 101), fakeObs(2, 100)];
  const r = reflect({
    observations: obs,
    harnessConfig: { proposeThreshold: 0.05 },
  });
  const thresholdProposal = r.proposals.find((p) => p.target === 'proposeThreshold');
  assert.ok(thresholdProposal);
  assert.ok(thresholdProposal.to < 0.05);
});

test('reflect: priorProposals filter prevents duplicates', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 95), fakeObs(2, 90)];
  const r = reflect({
    observations: obs,
    harnessConfig: { weights: { momentum: 0.5 } },
    priorProposals: [{ target: 'weights.momentum', from: 0.5, to: 0.4, rationale: 'prior', confidence: 0.5 }],
  });
  assert.equal(r.proposals.find((p) => p.target === 'weights.momentum'), undefined);
});

test('reflect: maxProposals caps output', () => {
  // Trigger multiple heuristics
  const obs = [fakeObs(0, 100), fakeObs(1, 150), fakeObs(2, 50, { tradeCount: 0 })];
  const r = reflect({
    observations: obs,
    harnessConfig: {
      weights: { momentum: 0.5 },
      drawdownStopPct: 0.20,
      minTradeNotional: 5,
      proposeThreshold: 0.05,
    },
    maxProposals: 2,
  });
  assert.ok(r.proposals.length <= 2);
});

test('reflect: deterministic given same inputs', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 95), fakeObs(2, 90)];
  const r1 = reflect({ observations: obs, harnessConfig: { weights: { momentum: 0.5 } } });
  const r2 = reflect({ observations: obs, harnessConfig: { weights: { momentum: 0.5 } } });
  assert.deepEqual(r1.proposals, r2.proposals);
});

test('reflect: no proposals when metrics are within acceptable bands', () => {
  // Mild positive growth, no big drawdown, with no flagging config -> 0 proposals
  const obs = [fakeObs(0, 100), fakeObs(1, 101), fakeObs(2, 102, { tradeCount: 3, realizedPnL: 2 })];
  const r = reflect({ observations: obs, harnessConfig: {} });
  assert.equal(r.proposals.length, 0);
});

test('renderReflection: produces a markdown body with sections', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 95), fakeObs(2, 90)];
  const r = reflect({
    observations: obs,
    harnessConfig: { weights: { momentum: 0.5 } },
  });
  const body = renderReflection(r, { tag: 'batch-001' });
  assert.match(body, /# Self-improvement reflection \(batch-001\)/);
  assert.match(body, /## Window summary/);
  assert.match(body, /## Proposals/);
  assert.match(body, /weights.momentum/);
});

test('renderReflection: empty proposals shows acceptable-bands note', () => {
  const r = { summary: { ticks: 0, initialEquity: 0, finalEquity: 0, totalPnL: 0, pnlPct: 0, maxDrawdown: 0, maxDrawdownPct: 0, volatility: 0, sharpe: 0, winRate: 0, tradeCount: 0 }, proposals: [] };
  const body = renderReflection(r);
  assert.match(body, /No proposals this batch/);
});

test('reflectAndRecord: dryRun returns body without recording', async () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 95), fakeObs(2, 90)];
  let recorded = false;
  const r = await reflectAndRecord({
    observations: obs,
    harnessConfig: { weights: { momentum: 0.5 } },
    journalRoot: '/nonexistent',
    recordEntry: async () => {
      recorded = true;
      return 'foo';
    },
    dryRun: true,
  });
  assert.equal(recorded, false);
  assert.match(r.body, /# Self-improvement reflection/);
  assert.ok(r.proposals.length > 0);
});

test('reflectAndRecord: passes through to recordEntry when not dryRun', async () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 95), fakeObs(2, 90)];
  let captured = null;
  const r = await reflectAndRecord({
    observations: obs,
    harnessConfig: { weights: { momentum: 0.5 } },
    journalRoot: '/journal',
    recordEntry: async (root, entry, opts) => {
      captured = { root, entry, opts };
      return 'entries/2026/06/18/foo.md';
    },
    role: 'simulator',
    project: 'finbot',
    tag: 'batch-007',
    localOnly: true,
  });
  assert.equal(captured.root, '/journal');
  assert.equal(captured.entry.kind, 'message');
  assert.equal(captured.entry.role, 'simulator');
  assert.equal(captured.entry.project, 'finbot');
  assert.equal(captured.entry.to, 'liaison');
  assert.equal(captured.opts.localOnly, true);
  assert.equal(r.path, 'entries/2026/06/18/foo.md');
});
