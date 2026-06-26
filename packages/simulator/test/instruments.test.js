import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  growthInstrument,
  yieldInstrument,
  dividendInstrument,
  instrumentReturns,
  mixReturns,
  instrumentReturnDistribution,
} from '../instruments.js';
import { gbmSeries } from '../fixtures.js';

const flat = (price, n) => new Array(n + 1).fill(price);

test('growth: no cash flows; total return is pure appreciation', () => {
  const series = [100, 110, 121];
  const r = instrumentReturns(growthInstrument({ series }));
  assert.ok(r.cashFlowSeries.every((c) => c === 0));
  assert.ok(Math.abs(r.totalReturn - 0.21) < 1e-9);
});

test('growth: flat price returns zero', () => {
  const r = instrumentReturns(growthInstrument({ series: flat(100, 50) }));
  assert.ok(Math.abs(r.totalReturn) < 1e-12);
});

test('yield: accrues positive cash under a flat price', () => {
  const N = 100;
  const yieldRate = 0.001;
  const r = instrumentReturns(yieldInstrument({ series: flat(100, N), yieldRate, accrualPeriod: 1 }));
  // total return == N * yieldRate (each tick accrues r * constant value).
  assert.ok(Math.abs(r.totalReturn - N * yieldRate) < 1e-9, `tr ${r.totalReturn}`);
  assert.ok(r.cumulativeCash > 0);
});

test('dividend: discrete payouts only at the period boundaries', () => {
  const N = 90;
  const period = 30;
  const dividendPerUnit = 2;
  const r = instrumentReturns(dividendInstrument({ series: flat(50, N), dividendPerUnit, period }), { qty: 1 });
  const payouts = r.cashFlowSeries.filter((c) => c > 0);
  assert.equal(payouts.length, Math.floor(N / period)); // t=30,60,90
  for (const c of payouts) assert.ok(Math.abs(c - dividendPerUnit) < 1e-12);
  assert.ok(Math.abs(r.totalReturn - (3 * dividendPerUnit) / 50) < 1e-9);
});

test('under flat price, yield and dividend beat growth', () => {
  const series = flat(100, 120);
  const g = instrumentReturns(growthInstrument({ series })).totalReturn;
  const y = instrumentReturns(yieldInstrument({ series, yieldRate: 0.0008 })).totalReturn;
  const d = instrumentReturns(dividendInstrument({ series, dividendPerUnit: 1, period: 20 })).totalReturn;
  assert.ok(y > g);
  assert.ok(d > g);
});

test('instrumentReturns: deterministic (pure over inputs)', () => {
  const series = gbmSeries({ length: 80, seed: 5 }).series;
  const a = instrumentReturns(yieldInstrument({ series, yieldRate: 0.0005 }));
  const b = instrumentReturns(yieldInstrument({ series, yieldRate: 0.0005 }));
  assert.deepEqual(a.totalValueSeries, b.totalValueSeries);
});

test('mixReturns: total value is the sum of the legs', () => {
  const series = flat(100, 40);
  const legs = [
    { instrument: growthInstrument({ asset: 'G', series }), qty: 1 },
    { instrument: yieldInstrument({ asset: 'Y', series, yieldRate: 0.001 }), qty: 1 },
  ];
  const mixed = mixReturns(legs);
  const g = instrumentReturns(growthInstrument({ series }), { qty: 1 });
  const y = instrumentReturns(yieldInstrument({ series, yieldRate: 0.001 }), { qty: 1 });
  for (let i = 0; i < mixed.totalValueSeries.length; i += 1) {
    assert.ok(Math.abs(mixed.totalValueSeries[i] - (g.totalValueSeries[i] + y.totalValueSeries[i])) < 1e-9);
  }
});

test('instrumentReturnDistribution: volatile growth carries more risk than calm yield', () => {
  const growth = instrumentReturnDistribution({
    id: 'growth',
    makeInstrument: (series) => growthInstrument({ series }),
    makeSeries: (seed) => gbmSeries({ initialPrice: 100, mu: 0.0015, sigma: 0.03, length: 64, seed }).series,
    realizationCount: 150,
  });
  const yld = instrumentReturnDistribution({
    id: 'yield',
    makeInstrument: (series) => yieldInstrument({ series, yieldRate: 0.0007 }),
    makeSeries: (seed) => gbmSeries({ initialPrice: 100, mu: 0.0002, sigma: 0.006, length: 64, seed }).series,
    realizationCount: 150,
  });
  assert.ok(growth.risk > yld.risk, `growth risk ${growth.risk} vs yield ${yld.risk}`);
  assert.ok(Number.isFinite(growth.reward) && Number.isFinite(yld.reward));
});
