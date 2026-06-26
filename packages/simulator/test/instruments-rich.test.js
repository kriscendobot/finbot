import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  growthInstrument,
  yieldInstrument,
  dividendInstrument,
  instrumentReturns,
  kinkedUtilizationApy,
  exDividendAdjustedSeries,
} from '../instruments.js';
import { sfc32 } from '../price-feed.js';

const flat = (price, n) => new Array(n + 1).fill(price);
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Yield: compounding vs simple, DRIP, curves, stochastic, utilization
// ---------------------------------------------------------------------------

test('yield: compounding flat-price total value is (1+r)^N', () => {
  const N = 50;
  const r = 0.002;
  const out = instrumentReturns(
    yieldInstrument({ series: flat(100, N), yieldRate: r, compounding: true }),
  );
  assert.ok(close(out.totalReturn, Math.pow(1 + r, N) - 1, 1e-7), `tr ${out.totalReturn}`);
});

test('yield: simple accrual is strictly below compounding under flat price', () => {
  const N = 50;
  const r = 0.002;
  const simple = instrumentReturns(yieldInstrument({ series: flat(100, N), yieldRate: r })).totalReturn;
  const comp = instrumentReturns(yieldInstrument({ series: flat(100, N), yieldRate: r, compounding: true })).totalReturn;
  assert.ok(close(simple, N * r, 1e-9), `simple ${simple}`);
  assert.ok(comp > simple, `comp ${comp} !> simple ${simple}`);
});

test('yield DRIP: reinvested into position; flat-price qty grows to (1+r)^N', () => {
  const N = 40;
  const r = 0.003;
  const out = instrumentReturns(
    yieldInstrument({ series: flat(100, N), yieldRate: r, reinvest: 'position' }),
  );
  const finalQty = out.qtySeries[out.qtySeries.length - 1];
  assert.ok(close(finalQty, Math.pow(1 + r, N), 1e-7), `qty ${finalQty}`);
  // DRIP routes nothing to cash; all return is in the position.
  assert.ok(close(out.cumulativeCash, 0, 1e-12), `cash ${out.cumulativeCash}`);
  assert.ok(close(out.totalReturn, Math.pow(1 + r, N) - 1, 1e-7));
});

test('yield curve: a rising rate array accrues more late than early', () => {
  const N = 8;
  // rate doubles each tick (held flat past the array end is irrelevant here)
  const curve = [0.001, 0.001, 0.002, 0.002, 0.004, 0.004, 0.008, 0.008, 0.008];
  const out = instrumentReturns(yieldInstrument({ series: flat(100, N), yieldRate: curve }));
  const cf = out.cashFlowSeries;
  // cf[t] = curve[t] * 100 for t>=1
  assert.ok(close(cf[1], 0.001 * 100));
  assert.ok(close(cf[7], 0.008 * 100));
  assert.ok(cf[7] > cf[1]);
});

test('yield: a stochastic short-rate (seeded function) is deterministic', () => {
  const N = 30;
  const makeInst = () => {
    const rng = sfc32(99);
    return yieldInstrument({
      series: flat(100, N),
      yieldRate: () => 0.001 + 0.002 * rng(),
    });
  };
  const a = instrumentReturns(makeInst());
  const b = instrumentReturns(makeInst());
  assert.deepEqual(a.totalValueSeries, b.totalValueSeries);
  assert.ok(a.cumulativeCash > 0);
});

test('yield: utilization-driven APY rises with utilization', () => {
  const N = 30;
  const apy = kinkedUtilizationApy({ base: 0, slope1: 0.001, slope2: 0.01, optimal: 0.8 });
  const low = instrumentReturns(
    yieldInstrument({ series: flat(100, N), utilization: 0.4, apyFromUtilization: apy }),
  );
  const high = instrumentReturns(
    yieldInstrument({ series: flat(100, N), utilization: 0.95, apyFromUtilization: apy }),
  );
  assert.ok(high.cumulativeCash > low.cumulativeCash, `${high.cumulativeCash} !> ${low.cumulativeCash}`);
  // kink: past optimal the rate jumps onto the steep slope
  assert.ok(apy(0.95) > apy(0.85));
});

// ---------------------------------------------------------------------------
// Dividend: growth, cuts, irregular schedule, payout ratio, ex-dividend
// ---------------------------------------------------------------------------

test('dividend growth: geometric per-payout increase', () => {
  const out = instrumentReturns(
    dividendInstrument({ series: flat(50, 90), dividendPerUnit: 1, dividendGrowth: 0.1, period: 30 }),
  );
  const payouts = out.cashFlowSeries.filter((c) => c > 0);
  assert.equal(payouts.length, 3);
  assert.ok(close(payouts[0], 1));
  assert.ok(close(payouts[1], 1.1));
  assert.ok(close(payouts[2], 1.21, 1e-9));
});

test('dividend cut: an explicit per-payout schedule that drops', () => {
  const out = instrumentReturns(
    dividendInstrument({ series: flat(50, 90), dividendPerUnit: [2, 2, 1], period: 30 }),
  );
  const payouts = out.cashFlowSeries.filter((c) => c > 0);
  assert.deepEqual(payouts.map((x) => Math.round(x * 100) / 100), [2, 2, 1]);
});

test('dividend: irregular payout schedule pays exactly at listed ticks', () => {
  const ticks = [10, 25, 40];
  const out = instrumentReturns(
    dividendInstrument({ series: flat(50, 50), dividendPerUnit: 1, payoutTicks: ticks }),
  );
  const paidAt = [];
  out.cashFlowSeries.forEach((c, t) => { if (c > 0) paidAt.push(t); });
  assert.deepEqual(paidAt, ticks);
});

test('dividend: payout-ratio over an earnings series cuts when earnings fall', () => {
  // earnings per unit drop after the first payout
  const earnings = [0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const out = instrumentReturns(
    dividendInstrument({ series: flat(50, 20), payoutRatio: 0.5, earningsPerUnit: earnings, period: 10 }),
  );
  const payouts = out.cashFlowSeries.filter((c) => c > 0);
  assert.equal(payouts.length, 2); // t=10 (earnings 4) and t=20 (earnings 1)
  assert.ok(close(payouts[0], 0.5 * 4));
  assert.ok(close(payouts[1], 0.5 * 1));
});

test('dividend ex-div: flat base price conserves total wealth at payout', () => {
  const N = 50;
  const out = instrumentReturns(
    dividendInstrument({ series: flat(100, N), dividendPerUnit: 1, period: 10, exDividendDrop: true }),
  );
  // 5 payouts of 1 each; price marked down cumulatively => total value flat.
  assert.ok(close(out.totalReturn, 0, 1e-9), `tr ${out.totalReturn}`);
  const finalPos = out.positionValueSeries[out.positionValueSeries.length - 1];
  assert.ok(close(finalPos, 95, 1e-9), `pos ${finalPos}`); // 100 - 5*1
  assert.ok(close(out.cumulativeCash, 5, 1e-9));
});

test('exDividendAdjustedSeries: materializes the drop onto the oracle', () => {
  const adj = exDividendAdjustedSeries(flat(100, 30), { dividendPerUnit: 2, period: 10 });
  assert.ok(close(adj[0], 100));
  assert.ok(close(adj[9], 100));
  assert.ok(close(adj[10], 98)); // first drop
  assert.ok(close(adj[20], 96)); // second drop
  assert.ok(close(adj[30], 94)); // third drop
});

// ---------------------------------------------------------------------------
// Fees and taxes
// ---------------------------------------------------------------------------

test('fees: a payout fee reduces accumulated cash', () => {
  const series = flat(100, 60);
  const noFee = instrumentReturns(yieldInstrument({ series, yieldRate: 0.001 }));
  const withFee = instrumentReturns(
    yieldInstrument({ series, yieldRate: 0.001, fees: { payoutBps: 100 } }),
  );
  assert.ok(withFee.cumulativeCash < noFee.cumulativeCash);
  assert.ok(withFee.cumulativeFees > 0);
  // 1% fee on each gross accrual
  assert.ok(close(withFee.cumulativeFees, noFee.cumulativeCash * 0.01, 1e-9));
});

test('taxes: income tax on payouts reduces net dividend cash', () => {
  const series = flat(100, 90);
  const pre = instrumentReturns(dividendInstrument({ series, dividendPerUnit: 2, period: 30 }));
  const post = instrumentReturns(
    dividendInstrument({ series, dividendPerUnit: 2, period: 30, tax: { income: 0.25 } }),
  );
  assert.ok(close(post.cumulativeCash, pre.cumulativeCash * 0.75, 1e-9));
  assert.ok(close(post.incomeTaxPaid, pre.cumulativeCash * 0.25, 1e-9));
});

test('taxes: capital-gains tax on the realized terminal gain', () => {
  const series = [100, 120, 150, 200]; // pure appreciation, no payouts
  const pre = instrumentReturns(growthInstrument({ series }));
  const post = instrumentReturns(growthInstrument({ series, tax: { capGains: 0.2 } }));
  assert.ok(close(pre.totalReturn, 1.0, 1e-9)); // 100 -> 200
  // gain = 200 - 100 = 100; tax = 20; after-tax terminal = 180 => tr = 0.8
  assert.ok(close(post.capGainsTax, 20, 1e-9));
  assert.ok(close(post.totalReturn, 0.8, 1e-9));
});

test('cash-flow accounting invariant: total = position + cumulative cash (minus terminal capgains)', () => {
  const out = instrumentReturns(
    dividendInstrument({ series: flat(80, 40), dividendPerUnit: 1.5, period: 8 }),
  );
  let running = 0;
  for (let t = 0; t < out.totalValueSeries.length; t += 1) {
    running += out.cashFlowSeries[t];
    assert.ok(
      close(out.totalValueSeries[t], out.positionValueSeries[t] + running, 1e-9),
      `mismatch at ${t}`,
    );
  }
});
