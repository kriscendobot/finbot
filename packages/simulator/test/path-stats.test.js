import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pathStatsOf } from '../path-stats.js';

test('pathStatsOf: monotone-up path has zero drawdown and recovers trivially', () => {
  const s = pathStatsOf([100, 101, 102, 110]);
  assert.equal(s.maxDrawdownPct, 0);
  assert.equal(s.timeToRecovery, 0);
  assert.equal(s.recovered, true);
});

test('pathStatsOf: V-shaped path measures drawdown and recovery time', () => {
  // peak 100 at idx 0, trough 80 at idx 2 (20% dd), reclaims 100 at idx 4.
  const s = pathStatsOf([100, 90, 80, 95, 100, 105]);
  assert.ok(Math.abs(s.maxDrawdownPct - 0.2) < 1e-12);
  assert.equal(s.troughIndex, 2);
  assert.equal(s.peakIndex, 0);
  assert.equal(s.timeToRecovery, 2, 'two ticks from trough (idx 2) to reclaim (idx 4)');
  assert.equal(s.recovered, true);
});

test('pathStatsOf: underwater-at-horizon path reports null recovery', () => {
  const s = pathStatsOf([100, 90, 70, 75, 80]);
  assert.ok(s.maxDrawdownPct > 0.25);
  assert.equal(s.timeToRecovery, null);
  assert.equal(s.recovered, false);
});

test('pathStatsOf: empty / single-point paths are safe', () => {
  assert.equal(pathStatsOf([]).maxDrawdownPct, 0);
  assert.equal(pathStatsOf([100]).maxDrawdownPct, 0);
  assert.equal(pathStatsOf([100]).recovered, true);
});

test('pathStatsOf: picks the deepest of multiple drawdowns', () => {
  // First dd 10% (100->90->100), then a deeper dd 30% (100->70).
  const s = pathStatsOf([100, 90, 100, 110, 77, 80]);
  assert.ok(Math.abs(s.maxDrawdownPct - 0.3) < 1e-12, 'deepest drawdown is 30%');
  assert.equal(s.troughIndex, 4);
});
