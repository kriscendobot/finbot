import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';
import { runOodaCycle } from '../ooda-cycle.js';

function dippingWorld(seed) {
  // Negative drift so the price tends to fall -> oracle-watcher fires a
  // down-deviation -> analyzer proposes buying the dip.
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: -0.01 }, seed },
    seed,
  });
}

function flatWorld(seed) {
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 10 }, initialPrice: 10 },
    priceFeed: { kind: 'replay', frames: Array.from({ length: 12 }, () => ({ ATOM: 10 })) },
    seed,
  });
}

const cycleConfig = {
  windowTicks: 10,
  oracle: { thresholdBps: 30 },
  analyzer: { scoreFloor: 0 },
  forecaster: { ensembleSize: 60, horizon: 12, baseSeed: 500 },
  bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
  auditor: { tailFloorPct: 0.6, stalenessWindowTicks: 12 },
};

test('OODA cycle: end-to-end dry-run completes and never touches the wallet', async () => {
  const world = dippingWorld(7);
  const sim = runSimulator(world);
  for (let i = 0; i < 10; i += 1) sim.tick();

  const res = await runOodaCycle({ world, history: sim.history, config: cycleConfig, cycleId: 't1' });

  assert.equal(res.outcome, 'dry-run-complete', res.summary);
  assert.ok(res.opportunities.length >= 1, 'oracle-watcher surfaced an opportunity');
  assert.equal(res.analysis.next_action, 'propose-rebalance');
  assert.ok(res.forecast.summary.p05 <= res.forecast.summary.p95);
  assert.equal(res.proposal.proposal_hash.length, 64);
  assert.equal(res.audit.verdict, 'approved', JSON.stringify(res.audit.failed_invariants));
  assert.equal(res.execution.mode, 'dry-run');
  assert.equal(res.execution.walletTouched, false);
  assert.equal(res.walletTouched, false);
});

test('OODA cycle: full provenance chain — proposal cites the forecast and analysis', async () => {
  const world = dippingWorld(7);
  const sim = runSimulator(world);
  for (let i = 0; i < 10; i += 1) sim.tick();
  const res = await runOodaCycle({ world, history: sim.history, config: cycleConfig, cycleId: 't2' });
  assert.ok(res.proposal.cited_forecasts.length >= 1);
  assert.ok(res.proposal.cited_analyses.length >= 1);
  // The audited hash is the planned hash (reproducibility holds end-to-end).
  assert.equal(res.audit.proposal_hash, res.proposal.proposal_hash);
});

test('OODA cycle: no opportunity -> short-circuits before orienting', async () => {
  const world = flatWorld(1);
  const sim = runSimulator(world);
  for (let i = 0; i < 10; i += 1) sim.tick();
  const res = await runOodaCycle({ world, history: sim.history, config: cycleConfig, cycleId: 't3' });
  assert.equal(res.outcome, 'no-opportunity');
  assert.equal(res.forecast, null);
  assert.equal(res.proposal, null);
  assert.equal(res.walletTouched, false);
});

test('OODA cycle: auditor rejection (tail floor too high) blocks execution', async () => {
  const world = dippingWorld(7);
  const sim = runSimulator(world);
  for (let i = 0; i < 10; i += 1) sim.tick();
  const strict = { ...cycleConfig, auditor: { tailFloorPct: 1.5, stalenessWindowTicks: 12 } };
  const res = await runOodaCycle({ world, history: sim.history, config: strict, cycleId: 't4' });
  assert.equal(res.outcome, 'rejected');
  assert.ok(res.audit.failed_invariants.includes('tail-risk-floor'));
  assert.equal(res.execution, null);
  assert.equal(res.walletTouched, false);
});

test('OODA cycle: records every stage when a recorder is supplied', async () => {
  const world = dippingWorld(7);
  const sim = runSimulator(world);
  for (let i = 0; i < 10; i += 1) sim.tick();
  const kinds = [];
  const recorder = { record: async (e) => { kinds.push(e.kind); return `mem:${e.kind}`; } };
  const res = await runOodaCycle({ world, history: sim.history, config: cycleConfig, recorder, cycleId: 't5' });
  assert.equal(res.outcome, 'dry-run-complete');
  assert.deepEqual(kinds, ['oracle-read', 'analysis', 'forecast', 'proposal', 'audit', 'execution']);
});
