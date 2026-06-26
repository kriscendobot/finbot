import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  riskAversionFromTolerance,
  toleranceFromRiskAversion,
  riskRewardScore,
  rewardRiskOf,
  chooseStrategy,
  toleranceFrontier,
  inferToleranceFromMaxDrawdown,
  inferToleranceFromLottery,
} from '../risk-reward.js';

test('riskAversionFromTolerance: monotone decreasing, balanced at 0.5', () => {
  assert.ok(Math.abs(riskAversionFromTolerance(0.5) - 1) < 1e-12);
  assert.ok(riskAversionFromTolerance(0.2) > riskAversionFromTolerance(0.8));
});

test('toleranceFromRiskAversion: inverse of riskAversionFromTolerance', () => {
  for (const tau of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const lambda = riskAversionFromTolerance(tau);
    assert.ok(Math.abs(toleranceFromRiskAversion(lambda) - tau) < 1e-9);
  }
});

test('riskRewardScore: high tolerance ranks the risky-but-rich strategy higher', () => {
  const safe = { reward: 0.03, risk: 0.05 };
  const risky = { reward: 0.12, risk: 0.30 };
  assert.ok(riskRewardScore(risky, 0.9) > riskRewardScore(safe, 0.9));
  assert.ok(riskRewardScore(safe, 0.1) > riskRewardScore(risky, 0.1));
});

test('rewardRiskOf: computes reward, risk, downside, worstLoss', () => {
  const r = rewardRiskOf([0.1, -0.05, 0.2, -0.1, 0.05]);
  assert.ok(Math.abs(r.reward - 0.04) < 1e-9);
  assert.ok(r.risk > 0);
  assert.ok(r.downside > 0);
  assert.equal(r.worstLoss, -0.1);
});

test('chooseStrategy: appetite selects the matching point', () => {
  const candidates = [
    { id: 'safe', reward: 0.02, risk: 0.05 },
    { id: 'mid', reward: 0.08, risk: 0.15 },
    { id: 'bold', reward: 0.15, risk: 0.35 },
  ];
  assert.equal(chooseStrategy(candidates, 0.05).chosen.id, 'safe');
  assert.equal(chooseStrategy(candidates, 0.95).chosen.id, 'bold');
});

test('toleranceFrontier: chosen risk is non-decreasing as tolerance rises', () => {
  const candidates = [
    { id: 'safe', reward: 0.02, risk: 0.05 },
    { id: 'mid', reward: 0.08, risk: 0.15 },
    { id: 'bold', reward: 0.15, risk: 0.35 },
  ];
  const frontier = toleranceFrontier({ candidates });
  for (let i = 1; i < frontier.length; i += 1) {
    assert.ok(frontier[i].risk >= frontier[i - 1].risk - 1e-12,
      `risk dropped at tau ${frontier[i].tolerance}`);
  }
  // Spans from the safe to the bold extreme.
  assert.equal(frontier[0].chosenId, 'safe');
  assert.equal(frontier[frontier.length - 1].chosenId, 'bold');
});

test('inferToleranceFromMaxDrawdown: monotone and clamped to [0,1]', () => {
  assert.equal(inferToleranceFromMaxDrawdown(0), 0);
  assert.equal(inferToleranceFromMaxDrawdown(0.25), 0.5);
  assert.equal(inferToleranceFromMaxDrawdown(0.5), 1);
  assert.equal(inferToleranceFromMaxDrawdown(0.9), 1); // clamped
  assert.ok(inferToleranceFromMaxDrawdown(0.1) < inferToleranceFromMaxDrawdown(0.3));
});

test('inferToleranceFromLottery: accepting a +EV gamble reveals a lower tolerance bound', () => {
  // Gamble: 0.5*120 + 0.5*80 = 100 EV vs a certain 100. Variance 400.
  const taken = inferToleranceFromLottery({ certain: 95, high: 120, low: 80, accepted: true });
  assert.equal(taken.kind, 'lower');
  // EV(100) > certain(95), so lambdaStar > 0 and toleranceBound in (0,1).
  assert.ok(taken.lambdaStar > 0);
  assert.ok(taken.toleranceBound > 0 && taken.toleranceBound < 1);
  // A more risk-tolerant accept (lower certain demanded) implies higher bound.
  const greedier = inferToleranceFromLottery({ certain: 99, high: 120, low: 80, accepted: true });
  assert.ok(greedier.toleranceBound > taken.toleranceBound);
});
