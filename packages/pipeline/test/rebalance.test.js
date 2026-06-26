import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Portfolio } from '@finbot/simulator/portfolio';
import {
  navOf, computeTargetBalances, deriveSteps, applyStepsToPortfolio,
} from '../rebalance.js';

const prices = { ATOM: 10 };

test('navOf: cash plus marked balances', () => {
  assert.equal(navOf({ cash: 100, balances: { ATOM: 5 } }, prices), 150);
});

test('computeTargetBalances: weight * nav per asset', () => {
  assert.deepEqual(computeTargetBalances(1000, { ATOM: 0.3 }), { ATOM: 300 });
});

test('deriveSteps: buys toward an under-weight target', () => {
  // NAV = 100 cash + 50 (5 ATOM @10) = 150. Target ATOM 0.5 -> 75 value; have 50 -> buy 25 worth.
  const { steps, clamped } = deriveSteps(
    { cash: 100, balances: { ATOM: 5 } }, prices, { ATOM: 0.5 },
    { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].side, 'buy');
  assert.equal(steps[0].asset, 'ATOM');
  assert.ok(Math.abs(steps[0].notional - 25) < 1e-9, `notional ${steps[0].notional}`);
  assert.equal(clamped, false);
});

test('deriveSteps: sells toward an over-weight target', () => {
  // NAV = 50 cash + 100 (10 ATOM @10) = 150. Target ATOM 0.2 -> 30 value; have 100 -> sell 70 worth.
  const { steps } = deriveSteps(
    { cash: 50, balances: { ATOM: 10 } }, prices, { ATOM: 0.2 },
    { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 1 },
  );
  assert.equal(steps[0].side, 'sell');
  assert.ok(Math.abs(steps[0].notional - 70) < 1e-9);
});

test('deriveSteps: per-step cap clamps the move', () => {
  const { steps, clamped } = deriveSteps(
    { cash: 1000, balances: { ATOM: 0 } }, prices, { ATOM: 0.9 },
    { maxStepPct: 0.1, maxDayPct: 1, concentrationCapPct: 1 },
  );
  // NAV 1000, per-step cap 100.
  assert.ok(steps[0].notional <= 100 + 1e-9, `notional ${steps[0].notional}`);
  assert.equal(clamped, true);
});

test('deriveSteps: concentration cap bounds resulting weight', () => {
  const { steps, clamped } = deriveSteps(
    { cash: 1000, balances: { ATOM: 0 } }, prices, { ATOM: 1.0 },
    { maxStepPct: 1, maxDayPct: 1, concentrationCapPct: 0.5 },
  );
  // NAV 1000, cap 0.5 -> at most 500 into ATOM.
  assert.ok(steps[0].notional <= 500 + 1e-9, `notional ${steps[0].notional}`);
  assert.equal(clamped, true);
});

test('deriveSteps: dust below minStepNotional is skipped', () => {
  // Current ATOM weight = 50 / 150 = 0.33333...; a target a hair above it
  // leaves a sub-$1 delta that must be skipped as dust.
  const { steps } = deriveSteps(
    { cash: 100, balances: { ATOM: 5 } }, prices, { ATOM: 0.3333335 },
    { minStepNotional: 1 },
  );
  assert.equal(steps.length, 0);
});

test('applyStepsToPortfolio: applies buys against a real Portfolio', () => {
  const pf = new Portfolio({ cash: 100, balances: { ATOM: 0 } });
  const steps = [{ side: 'buy', asset: 'ATOM', qty: 5, price: 10, notional: 50 }];
  const { applied, skipped } = applyStepsToPortfolio(pf, prices, steps, 1);
  assert.equal(applied.length, 1);
  assert.equal(skipped.length, 0);
  assert.equal(pf.cash, 50);
  assert.equal(pf.balances.ATOM, 5);
});

test('applyStepsToPortfolio: skips a step the portfolio rejects', () => {
  const pf = new Portfolio({ cash: 10, balances: { ATOM: 0 } });
  const steps = [{ side: 'buy', asset: 'ATOM', qty: 5, price: 10, notional: 50 }];
  const { applied, skipped } = applyStepsToPortfolio(pf, prices, steps, 1);
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /insufficient cash/);
});
