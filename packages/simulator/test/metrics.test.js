import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  perTickMetrics,
  summaryMetrics,
  meanStddev,
  rowsToJsonl,
  rowsToCsv,
} from '../metrics.js';

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

test('meanStddev: empty returns zeros', () => {
  assert.deepEqual(meanStddev([]), { mean: 0, stddev: 0 });
});

test('meanStddev: single value has zero stddev', () => {
  assert.deepEqual(meanStddev([5]), { mean: 5, stddev: 0 });
});

test('meanStddev: simple case', () => {
  // [2, 4, 4, 4, 5, 5, 7, 9] mean 5, sample stddev = sqrt(32/7) ≈ 2.138
  const { mean, stddev } = meanStddev([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.ok(Math.abs(stddev - 2.138) < 0.01);
});

test('perTickMetrics: empty observations returns empty rows', () => {
  assert.deepEqual(perTickMetrics([]), []);
});

test('perTickMetrics: monotonic equity has zero drawdown', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 105), fakeObs(2, 110)];
  const rows = perTickMetrics(obs);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].drawdown, 0);
  assert.equal(rows[2].drawdownPct, 0);
});

test('perTickMetrics: tracks drawdown from peak', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 120), fakeObs(2, 90)];
  const rows = perTickMetrics(obs);
  assert.equal(rows[2].drawdown, 30);  // peak 120 - 90
  assert.ok(Math.abs(rows[2].drawdownPct - 0.25) < 1e-9);
});

test('perTickMetrics: log return is consistent', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 110)];
  const rows = perTickMetrics(obs);
  assert.ok(Math.abs(rows[1].logReturn - Math.log(1.1)) < 1e-9);
});

test('perTickMetrics: pnlPct computed from initial', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 105), fakeObs(2, 120)];
  const rows = perTickMetrics(obs);
  assert.ok(Math.abs(rows[2].pnlPct - 0.2) < 1e-9);
});

test('summaryMetrics: empty input safe', () => {
  const s = summaryMetrics([]);
  assert.equal(s.ticks, 0);
  assert.equal(s.sharpe, 0);
});

test('summaryMetrics: flat equity has zero P&L', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 100), fakeObs(2, 100)];
  const s = summaryMetrics(obs);
  assert.equal(s.totalPnL, 0);
  assert.equal(s.pnlPct, 0);
  assert.equal(s.maxDrawdown, 0);
});

test('summaryMetrics: monotonic increase has positive Sharpe', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 105), fakeObs(2, 110), fakeObs(3, 116)];
  const s = summaryMetrics(obs);
  assert.ok(s.totalPnL > 0);
  assert.ok(s.pnlPct > 0);
  // returns are positive each tick, so Sharpe (mean/std * sqrt(252)) should
  // be finite and positive
  assert.ok(s.sharpe > 0);
});

test('summaryMetrics: drawdown captured correctly', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 150), fakeObs(2, 75)];
  const s = summaryMetrics(obs);
  assert.equal(s.maxDrawdown, 75);
  assert.ok(Math.abs(s.maxDrawdownPct - 0.5) < 1e-9);
});

test('summaryMetrics: win rate proxy from realizedPnL', () => {
  const obs = [
    fakeObs(0, 100, { tradeCount: 0, realizedPnL: 0 }),
    fakeObs(1, 110, { tradeCount: 2, realizedPnL: 10 }),
  ];
  assert.equal(summaryMetrics(obs).winRate, 1);
});

test('summaryMetrics: zero trades has zero win rate', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 110)];
  assert.equal(summaryMetrics(obs).winRate, 0);
});

test('rowsToJsonl: serializes one row per line', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 110)];
  const rows = perTickMetrics(obs);
  const jsonl = rowsToJsonl(rows);
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).t, 0);
});

test('rowsToCsv: header + body', () => {
  const obs = [fakeObs(0, 100), fakeObs(1, 110)];
  const rows = perTickMetrics(obs);
  const csv = rowsToCsv(rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('equity'));
});
