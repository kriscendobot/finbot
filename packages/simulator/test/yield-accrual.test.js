import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Portfolio } from '../portfolio.js';
import { makeWorld } from '../world.js';
import { runSimulator } from '../runner.js';
import {
  accruePortfolio,
  hasAccruingInstrument,
  aprOf,
  aprToPerPeriodRate,
} from '../yield-accrual.js';

// ---------- APR helpers ----------

test('aprToPerPeriodRate: annualized rate splits across the year', () => {
  assert.ok(Math.abs(aprToPerPeriodRate(0.365, 1, 365) - 0.001) < 1e-12);
  assert.ok(Math.abs(aprToPerPeriodRate(0.365, 7, 365) - 0.007) < 1e-12);
  assert.equal(aprToPerPeriodRate(0, 1, 365), 0);
  assert.equal(aprToPerPeriodRate(Number.NaN), 0);
});

test('aprOf: reads apr directly, annualizes a scalar yieldRate, zero otherwise', () => {
  assert.equal(aprOf({ type: 'yield', apr: 0.12 }), 0.12);
  assert.ok(Math.abs(aprOf({ type: 'yield', yieldRate: 0.001, accrualPeriod: 1, ticksPerYear: 365 }) - 0.365) < 1e-12);
  assert.equal(aprOf({ type: 'growth' }), 0);
  assert.equal(aprOf({ type: 'yield', yieldRate: [0.001, 0.002] }), 0); // a curve has no single headline rate
  assert.equal(aprOf(undefined), 0);
});

// ---------- live accrual ----------

function yieldPortfolio() {
  return new Portfolio({ cash: 0, balances: { Y: 100 } });
}

test('accruePortfolio: yield accrues into cash on the position value', () => {
  const pf = yieldPortfolio();
  const instruments = { Y: { type: 'yield', yieldRate: 0.01, accrualPeriod: 1, reinvest: 'cash' } };
  const state = {};
  // positionValue = 100 * 10 = 1000; rate 0.01 -> 10 into cash.
  const flows = accruePortfolio(pf, instruments, 1, { Y: 10 }, state);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].kind, 'yield');
  assert.ok(Math.abs(flows[0].net - 10) < 1e-9);
  assert.ok(Math.abs(pf.cash - 10) < 1e-9);
  assert.ok(Math.abs(pf.accruedIncome - 10) < 1e-9);
  // markToMarket folds the accrued income into total P&L.
  const snap = pf.markToMarket({ Y: 10 });
  assert.ok(Math.abs(snap.accruedIncome - 10) < 1e-9);
});

test('accruePortfolio: apr alias converts to the per-tick rate', () => {
  const pf = yieldPortfolio();
  const instruments = { Y: { type: 'yield', apr: 0.365, accrualPeriod: 1, ticksPerYear: 365, reinvest: 'cash' } };
  const flows = accruePortfolio(pf, instruments, 1, { Y: 10 }, {});
  // per-tick rate 0.001 on a 1000 position -> 1.0 into cash.
  assert.ok(Math.abs(flows[0].net - 1) < 1e-9);
});

test('accruePortfolio: DRIP reinvests into the position, net cash zero', () => {
  const pf = yieldPortfolio();
  const instruments = { Y: { type: 'yield', yieldRate: 0.01, accrualPeriod: 1, reinvest: 'position' } };
  const flows = accruePortfolio(pf, instruments, 1, { Y: 10 }, {});
  // gross 10, reinvest 10/price(10) = 1 extra unit; cash returns to 0.
  assert.ok(Math.abs(pf.cash) < 1e-9);
  assert.ok(Math.abs(pf.balances.Y - 101) < 1e-9);
  assert.ok(flows[0].reinvested > 0);
});

test('accruePortfolio: accrualPeriod gates accrual to multiples of the period', () => {
  const pf = yieldPortfolio();
  const instruments = { Y: { type: 'yield', yieldRate: 0.01, accrualPeriod: 3 } };
  const state = {};
  assert.equal(accruePortfolio(pf, instruments, 1, { Y: 10 }, state).length, 0);
  assert.equal(accruePortfolio(pf, instruments, 2, { Y: 10 }, state).length, 0);
  assert.equal(accruePortfolio(pf, instruments, 3, { Y: 10 }, state).length, 1);
});

test('accruePortfolio: dividend pays on its schedule', () => {
  const pf = yieldPortfolio();
  const instruments = { Y: { type: 'dividend', dividendPerUnit: 1, period: 2, reinvest: 'cash' } };
  const state = {};
  assert.equal(accruePortfolio(pf, instruments, 1, { Y: 10 }, state).length, 0);
  const flows = accruePortfolio(pf, instruments, 2, { Y: 10 }, state);
  assert.equal(flows[0].kind, 'dividend');
  // 100 units * 1 per unit = 100 into cash.
  assert.ok(Math.abs(pf.cash - 100) < 1e-9);
});

test('accruePortfolio: growth legs and unheld assets accrue nothing', () => {
  const pf = new Portfolio({ cash: 0, balances: { G: 100 } });
  const instruments = {
    G: { type: 'growth' },
    Y: { type: 'yield', yieldRate: 0.01 }, // not held -> skipped
  };
  const flows = accruePortfolio(pf, instruments, 1, { G: 10, Y: 10 }, {});
  assert.equal(flows.length, 0);
  assert.equal(pf.cash, 0);
});

test('accruePortfolio: payout fee and income tax are deducted before crediting', () => {
  const pf = yieldPortfolio();
  const instruments = {
    Y: {
      type: 'yield', yieldRate: 0.01, reinvest: 'cash',
      fees: { payoutBps: 1000 }, tax: { income: 0.5 },
    },
  };
  const flows = accruePortfolio(pf, instruments, 1, { Y: 10 }, {});
  // gross 10; fee 10% -> 1; afterFee 9; income tax 50% -> 4.5; net 4.5.
  assert.ok(Math.abs(flows[0].fee - 1) < 1e-9);
  assert.ok(Math.abs(flows[0].incomeTax - 4.5) < 1e-9);
  assert.ok(Math.abs(pf.cash - 4.5) < 1e-9);
});

test('hasAccruingInstrument: true only with a yield or dividend leg', () => {
  assert.equal(hasAccruingInstrument(undefined), false);
  assert.equal(hasAccruingInstrument({ A: { type: 'growth' } }), false);
  assert.equal(hasAccruingInstrument({ A: { type: 'growth' }, B: { type: 'yield' } }), true);
  assert.equal(hasAccruingInstrument({ A: { type: 'dividend' } }), true);
});

// ---------- accrual threaded through the runner ----------

function accruingWorld(seed) {
  return makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 100, sATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'replay', frames: Array.from({ length: 24 }, () => ({ ATOM: 10, sATOM: 11 })) },
    instruments: {
      ATOM: { type: 'growth' },
      sATOM: { type: 'yield', apr: 0.365, accrualPeriod: 1, ticksPerYear: 365, reinvest: 'cash' },
    },
    seed,
  });
}

test('runSimulator: a yield position accrues over ticks into equity', () => {
  const sim = runSimulator(accruingWorld(1));
  const before = sim.observe().portfolio.equity;
  for (let i = 0; i < 10; i += 1) sim.tick();
  const obs = sim.observe();
  // 50 units * 11 price * 0.001 per tick = 0.55/tick; flat price so equity
  // rises purely from accrual over 10 ticks.
  assert.ok(obs.portfolio.equity > before);
  assert.ok(Math.abs(obs.portfolio.accruedIncome - 5.5) < 1e-6);
  // The latest ticks carry an accrual record in the observation.
  const last = sim.history[sim.history.length - 1];
  assert.ok(Array.isArray(last.accruals) && last.accruals.length === 1);
  assert.equal(last.accruals[0].asset, 'sATOM');
});

test('runSimulator: accrual is deterministic across identical runs', () => {
  const a = runSimulator(accruingWorld(7));
  const b = runSimulator(accruingWorld(7));
  for (let i = 0; i < 12; i += 1) { a.tick(); b.tick(); }
  assert.equal(a.observe().portfolio.accruedIncome, b.observe().portfolio.accruedIncome);
});

test('runSimulator: forked child accrues on its own carried instrument registry', () => {
  const sim = runSimulator(accruingWorld(3));
  for (let i = 0; i < 5; i += 1) sim.tick();
  const child = sim.fork(99);
  const childBefore = child.observe().portfolio.accruedIncome;
  for (let i = 0; i < 5; i += 1) child.tick();
  const childAfter = child.observe().portfolio.accruedIncome;
  assert.ok(childAfter > childBefore, 'the forked world accrues independently');
});

test('runSimulator: a world with no instrument registry accrues nothing', () => {
  const sim = runSimulator(makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 100 }, initialPrice: 10 },
    priceFeed: { kind: 'replay', frames: Array.from({ length: 12 }, () => ({ ATOM: 10 })) },
  }));
  for (let i = 0; i < 10; i += 1) sim.tick();
  const obs = sim.observe();
  assert.equal(obs.portfolio.accruedIncome, 0);
  assert.equal(obs.accruals, undefined);
});
