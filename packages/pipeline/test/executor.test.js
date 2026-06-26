import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '@finbot/simulator/world';
import { plan } from '../planner.js';
import { execute } from '../executor.js';

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
