import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { plan } from '../planner.js';
import { execute } from '../executor.js';
import { project, projectionId } from '../forecaster.js';

function setup() {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 0 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.01 }, drifts: { ATOM: 0 }, seed: 3 },
    seed: 3,
  });
  const prices = world.priceFeed.current();
  const proposal = plan({
    portfolio: world.portfolio.markToMarket(prices),
    prices,
    targetWeights: { ATOM: 0.3 },
    bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
    cited_forecasts: ['f'],
    cited_analyses: ['a'],
  });
  const forecast = { p05Equity: 950, summary: { p05: 950, p50: 1000, p95: 1050 } };
  return { world, proposal, forecast };
}

test('executor dry-run: never touches a wallet', async () => {
  const { world, proposal, forecast } = setup();
  const r = await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'dry-run', auditConfig: { tailFloorPct: 0.8, maxStepPct: 1 } },
  );
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.walletTouched, false);
  assert.equal(r.fire_time_audit.verdict, 'approved');
  assert.ok(r.steps_completed.length >= 1);
});

test('executor dry-run: does NOT mutate the live world (simulates on a clone)', async () => {
  const { world, proposal, forecast } = setup();
  const cashBefore = world.portfolio.cash;
  const atomBefore = world.portfolio.balances.ATOM || 0;
  await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'dry-run', auditConfig: { tailFloorPct: 0.8, maxStepPct: 1 } },
  );
  assert.equal(world.portfolio.cash, cashBefore, 'live cash unchanged');
  assert.equal(world.portfolio.balances.ATOM || 0, atomBefore, 'live ATOM balance unchanged');
});

test('executor: refuses live mode without authorization (no keystore read, no signing)', async () => {
  const { world, proposal, forecast } = setup();
  const r = await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'live', live_authorized: false },
  );
  assert.ok(r.refusal, 'should carry a refusal');
  assert.equal(r.walletTouched, false);
  assert.equal(r.steps_completed.length, 0);
});

// The armed data-sufficiency gate's fire-time drift guard, end to end: a forged
// descriptor must complete NO steps. This is the executor half of the provenance
// binding — the auditor half is pinned in auditor-data-sufficiency.test.js — and
// it exercises the real project() -> plan() -> execute() path the finding named.
const DIP = [10, 10.05, 9.98, 10.02];
function realForecastSetup() {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 0 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'executor-data-sufficiency',
  });
  const readings = DIP.map((p, i) => ({ t: i, prices: { ATOM: p } }));
  // 4 frames -> 3 observed returns; a 20-tick horizon -> coverage 0.15.
  const forecast = project(
    { world, targetWeights: { ATOM: 0.3 }, readings },
    {
      ensembleSize: 8, horizon: 20, baseSeed: 100, render: false, reportDataSufficiency: true,
    },
  );
  const prices = world.priceFeed.current();
  const proposal = plan({
    portfolio: world.portfolio.markToMarket(prices),
    prices,
    targetWeights: { ATOM: 0.3 },
    bounds: { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
    // Cite the forecast by its canonical projectionId, exactly as the pipeline does.
    cited_forecasts: [projectionId(forecast)],
    cited_analyses: ['a'],
  });
  return { world, forecast, proposal };
}

const permissiveBounds = { tailFloorPct: 0.5, maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 };
const armedAudit = { ...permissiveBounds, dataSufficiencyMinCoverage: 1 };

test('executor: with the gate OFF the honest forecast completes steps (the control)', async () => {
  // Proves the setup can complete steps at all, so "0 steps" below is the gate
  // biting rather than an empty plan.
  const { world, forecast, proposal } = realForecastSetup();
  const r = await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'dry-run', auditConfig: permissiveBounds },
  );
  assert.equal(r.fire_time_audit.verdict, 'approved');
  assert.ok(r.steps_completed.length >= 1, 'the honest cycle completes a step when the gate is off');
});

test('executor: an armed gate completes NO steps under a forged data-sufficiency descriptor', async () => {
  const { world, forecast, proposal } = realForecastSetup();
  const sufficiencyOf = (audit) =>
    audit.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');

  // The honest thin forecast is rejected on COVERAGE (0.15 < 1) and completes no
  // steps — and its descriptor IS bound, so the reject is the coverage floor, not
  // the binding.
  const honest = await execute(
    { proposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'dry-run', auditConfig: armedAudit },
  );
  assert.equal(honest.fire_time_audit.verdict, 'rejected');
  assert.equal(honest.steps_completed.length, 0);
  assert.match(sufficiencyOf(honest.fire_time_audit).detail, /coverage 0\.150 .* vs required 1\.000/);

  // Forge a fat, internally consistent descriptor onto the SAME forecast the
  // proposal cited. The recomputed projectionId no longer matches the cited id,
  // so the fire-time audit fails the gate closed and NO steps complete.
  const forged = {
    ...forecast,
    dataSufficiency: {
      coverageRatio: 1, historyReturns: 20, historyFrames: 21, horizon: forecast.horizon, worstAsset: 'ATOM',
    },
  };
  const r = await execute(
    { proposal, world, forecast: forged, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'dry-run', auditConfig: armedAudit },
  );
  assert.equal(r.fire_time_audit.verdict, 'rejected');
  assert.ok(r.fire_time_audit.failed_invariants.includes('forecast-data-sufficiency'));
  assert.match(sufficiencyOf(r.fire_time_audit).detail, /not bound to a forecast artifact the proposal cites/);
  assert.equal(r.steps_completed.length, 0, 'a forged descriptor completes no steps');
  assert.equal(r.walletTouched, false);
});

test('executor dry-run: empty plan completes with no steps', async () => {
  const { world, forecast } = setup();
  const prices = world.priceFeed.current();
  const emptyProposal = plan({
    portfolio: world.portfolio.markToMarket(prices),
    prices,
    targetWeights: { ATOM: 0 }, // already at 0
    bounds: {},
    cited_forecasts: ['f'],
    cited_analyses: ['a'],
  });
  const r = await execute(
    { proposal: emptyProposal, world, forecast, currentTick: world.priceFeed.t, oracleReadings: [], parentCaps: {} },
    { mode: 'dry-run', auditConfig: { tailFloorPct: 0.8, maxStepPct: 1 } },
  );
  // empty steps -> citation-completeness fails -> fire-time audit rejects -> no sim steps
  assert.equal(r.walletTouched, false);
  assert.equal(r.steps_completed.length, 0);
});
