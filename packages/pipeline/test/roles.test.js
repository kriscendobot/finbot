import { test } from 'node:test';
import assert from 'node:assert/strict';

import { observeOpportunities, windowFromHistory } from '../oracle-watcher.js';
import { analyze, realizedVolatility } from '../analyzer.js';
import { plan, hashProposal } from '../planner.js';
import { audit } from '../auditor.js';

function readings(seq, asset = 'ATOM', startTick = 0) {
  return seq.map((p, i) => ({ t: startTick + i, prices: { [asset]: p } }));
}

// ---------- oracle-watcher ----------

test('oracle-watcher: emits a crossing past threshold', () => {
  const out = observeOpportunities({ readings: readings([10, 10.1, 10.6]) }, { thresholdBps: 50 });
  assert.equal(out.crossings.length, 1);
  assert.equal(out.crossings[0].asset, 'ATOM');
  assert.equal(out.crossings[0].direction, 'up');
  assert.ok(out.crossings[0].deviationBps > 500);
  assert.equal(out.observedAtTick, 2);
});

test('oracle-watcher: no crossing below threshold', () => {
  const out = observeOpportunities({ readings: readings([10, 10.01]) }, { thresholdBps: 50 });
  assert.equal(out.crossings.length, 0);
});

test('oracle-watcher: down deviation flagged', () => {
  const out = observeOpportunities({ readings: readings([10, 9.0]) }, { thresholdBps: 50 });
  assert.equal(out.crossings[0].direction, 'down');
  assert.ok(out.crossings[0].deviationBps < 0);
});

test('oracle-watcher: fewer than two readings -> no crossings', () => {
  const out = observeOpportunities({ readings: readings([10]) });
  assert.equal(out.crossings.length, 0);
  assert.deepEqual(out.readings, { ATOM: 10 });
});

test('windowFromHistory: takes the trailing window', () => {
  const hist = [0, 1, 2, 3, 4].map((t) => ({ t, prices: { ATOM: 10 + t } }));
  const w = windowFromHistory(hist, 3);
  assert.equal(w.length, 3);
  assert.equal(w[0].t, 2);
});

// ---------- analyzer ----------

test('realizedVolatility: positive for a moving series', () => {
  const vol = realizedVolatility(readings([10, 10.5, 9.8, 10.2]), 'ATOM');
  assert.ok(vol > 0);
});

test('analyzer: proposes a rebalance on a meaningful dip', () => {
  const r = readings([10, 9.5, 9.0]);
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 50 }).crossings;
  const a = analyze(
    { opportunities: opp, readings: r, portfolio: { cash: 1000, balances: { ATOM: 10 } }, prices: { ATOM: 9 } },
    { scoreFloor: 0 },
  );
  assert.equal(a.next_action, 'propose-rebalance');
  assert.ok(a.targetWeights.ATOM >= 0);
});

test('analyzer: no-action when top score below the floor', () => {
  const r = readings([10, 10.6]); // up-deviation -> negative buy edge -> low score
  const opp = observeOpportunities({ readings: r }, { thresholdBps: 50 }).crossings;
  const a = analyze(
    { opportunities: opp, readings: r, portfolio: { cash: 1000, balances: { ATOM: 10 } }, prices: { ATOM: 10.6 } },
    { scoreFloor: 0.05 },
  );
  assert.equal(a.next_action, 'no-action');
});

// ---------- planner ----------

const plannerInput = {
  portfolio: { cash: 1000, balances: { ATOM: 0 }, quoteCurrency: 'USDC' },
  prices: { ATOM: 10 },
  targetWeights: { ATOM: 0.3 },
  bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
  cited_forecasts: ['forecast:x'],
  cited_analyses: ['analysis:x'],
};

test('planner: deterministic proposal_hash over identical inputs', () => {
  const p1 = plan(plannerInput);
  const p2 = plan(plannerInput);
  assert.equal(p1.proposal_hash, p2.proposal_hash);
  assert.equal(p1.proposal_hash.length, 64);
});

test('planner: carries citations and a dry-run summary', () => {
  const p = plan(plannerInput);
  assert.deepEqual(p.cited_forecasts, ['forecast:x']);
  assert.deepEqual(p.cited_analyses, ['analysis:x']);
  assert.match(p.dry_run_summary, /buy/);
  assert.ok(p.steps.length >= 1);
});

test('planner: hashProposal changes when a step changes', () => {
  const a = hashProposal([{ source: 'USDC', dest: 'ATOM', side: 'buy', asset: 'ATOM', qty: 1, price: 10, notional: 10 }]);
  const b = hashProposal([{ source: 'USDC', dest: 'ATOM', side: 'buy', asset: 'ATOM', qty: 2, price: 10, notional: 20 }]);
  assert.notEqual(a, b);
});

// ---------- auditor ----------

function auditCtx(overrides = {}) {
  const proposal = plan(plannerInput);
  const forecast = { p05Equity: 950, p50Equity: 1000, p95Equity: 1100, summary: { p05: 950, p50: 1000, p95: 1100 } };
  return {
    proposal,
    forecast,
    portfolio: { cash: 1000, balances: { ATOM: 0 } },
    prices: { ATOM: 10 },
    currentTick: 10,
    oracleReadings: [{ asset: 'ATOM', observedAtTick: 9, deviationBps: -300 }],
    ...overrides,
  };
}

test('auditor: approves a well-formed, in-bounds, fresh proposal', () => {
  // maxStepPct: 1 matches the bounds the plannerInput planned within.
  const v = audit(auditCtx(), { maxStepPct: 1, tailFloorPct: 0.8, stalenessWindowTicks: 5 });
  assert.equal(v.verdict, 'approved', JSON.stringify(v.failed_invariants));
});

test('auditor: rejects on missing citations', () => {
  const ctx = auditCtx();
  ctx.proposal = { ...ctx.proposal, cited_forecasts: [], cited_analyses: [] };
  const v = audit(ctx, {});
  assert.equal(v.verdict, 'rejected');
  assert.ok(v.failed_invariants.includes('citation-completeness'));
});

test('auditor: rejects on tail-risk floor breach', () => {
  const ctx = auditCtx({ forecast: { p05Equity: 500, summary: { p05: 500, p50: 600, p95: 700 } } });
  const v = audit(ctx, { tailFloorPct: 0.8 });
  assert.equal(v.verdict, 'rejected');
  assert.ok(v.failed_invariants.includes('tail-risk-floor'));
});

test('auditor: rejects on hash tamper (reproducibility)', () => {
  const ctx = auditCtx();
  ctx.proposal = { ...ctx.proposal, steps: ctx.proposal.steps.map((s) => ({ ...s, qty: s.qty + 1 })) };
  const v = audit(ctx, { tailFloorPct: 0.8 });
  assert.equal(v.verdict, 'rejected');
  assert.ok(v.failed_invariants.includes('reproducibility'));
});

test('auditor: rejects on stale cited reading (freshness)', () => {
  const ctx = auditCtx({ oracleReadings: [{ asset: 'ATOM', observedAtTick: 1, deviationBps: -300 }], currentTick: 100 });
  const v = audit(ctx, { tailFloorPct: 0.8, stalenessWindowTicks: 5 });
  assert.equal(v.verdict, 'rejected');
  assert.ok(v.failed_invariants.includes('pricing-freshness'));
});

test('auditor: rejects on per-step risk-bound breach', () => {
  const ctx = auditCtx();
  // Force an oversized step relative to a tiny configured cap.
  const v = audit(ctx, { maxStepPct: 0.001, tailFloorPct: 0.8 });
  assert.equal(v.verdict, 'rejected');
  assert.ok(v.failed_invariants.includes('risk-bound-compliance'));
});
