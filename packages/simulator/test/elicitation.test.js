import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toleranceFromRiskAversion } from '../risk-reward.js';
import {
  startLotteryLadder,
  ladderDone,
  nextLotteryQuestion,
  answerLotteryQuestion,
  ladderEstimate,
  runLotteryLadder,
  truthfulLadderResponder,
  signalFromLadder,
  signalFromDrawdown,
  signalFromSharpe,
  signalFromSlider,
  signalFromLottery,
  reconcileSignals,
  recalibrationStatus,
  DEFAULT_CADENCE_MS,
} from '../elicitation.js';

// --- Lottery ladder -------------------------------------------------------

test('lottery ladder: a truthful user recovers a known risk aversion', () => {
  for (const trueLambda of [0.5, 1, 3, 7]) {
    const { estimate } = runLotteryLadder({
      responder: truthfulLadderResponder(trueLambda),
      ladder: { maxSteps: 10 },
    });
    // 10 halvings of [0,20] -> resolution ~0.02; estimate brackets trueLambda.
    assert.ok(Math.abs(estimate.lambda - trueLambda) < 0.05,
      `lambda ${estimate.lambda} vs ${trueLambda}`);
    assert.ok(estimate.lambdaLo <= trueLambda && trueLambda <= estimate.lambdaHi,
      `bracket [${estimate.lambdaLo}, ${estimate.lambdaHi}] excludes ${trueLambda}`);
    // tau is the matching tolerance, inside its own band.
    assert.ok(Math.abs(estimate.tau - toleranceFromRiskAversion(trueLambda)) < 0.03);
    assert.ok(estimate.tauLo <= estimate.tau && estimate.tau <= estimate.tauHi);
  }
});

test('lottery ladder: deterministic and adaptive (questions depend on answers)', () => {
  const a = runLotteryLadder({ responder: truthfulLadderResponder(2) });
  const b = runLotteryLadder({ responder: truthfulLadderResponder(2) });
  assert.deepEqual(a.trace, b.trace); // same inputs -> identical trace
  // An always-accept user and an always-decline user see different 2nd questions.
  const accept = startLotteryLadder({});
  const decline = startLotteryLadder({});
  const q0a = nextLotteryQuestion(accept);
  const q0d = nextLotteryQuestion(decline);
  assert.equal(q0a.certain, q0d.certain); // first rung is identical
  const q1a = nextLotteryQuestion(answerLotteryQuestion(accept, true));
  const q1d = nextLotteryQuestion(answerLotteryQuestion(decline, false));
  assert.notEqual(q1a.certain, q1d.certain); // second rung diverges -> adaptive
});

test('lottery ladder: the offered certain amount is below EV for a positive rung', () => {
  const state = startLotteryLadder({});
  const q = nextLotteryQuestion(state);
  assert.ok(Math.abs(q.expectedValue - 0.1) < 1e-12); // 0.5*0.3 + 0.5*(-0.1)
  assert.ok(q.certain < q.expectedValue); // a risk-averse midpoint discounts EV
  // The certain amount stays inside the gamble's own range (no absurd rungs).
  assert.ok(q.certain >= q.low && q.certain <= q.high);
});

test('lottery ladder: every rung offers a sane in-range certain amount', () => {
  // Walk the worst-case branch (always decline -> drive lambda to the ceiling).
  let state = startLotteryLadder({});
  while (!ladderDone(state)) {
    const q = nextLotteryQuestion(state);
    assert.ok(q.certain >= q.low - 1e-9 && q.certain <= q.high + 1e-9,
      `certain ${q.certain} outside [${q.low}, ${q.high}]`);
    state = answerLotteryQuestion(state, false);
  }
});

test('lottery ladder: narrower with more steps (tighter sigma)', () => {
  const few = runLotteryLadder({ responder: truthfulLadderResponder(3), ladder: { maxSteps: 3 } });
  const many = runLotteryLadder({ responder: truthfulLadderResponder(3), ladder: { maxSteps: 9 } });
  assert.ok(many.estimate.sigma < few.estimate.sigma);
  assert.ok(ladderDone(many.state));
});

test('lottery ladder: lambdaTolerance stops early', () => {
  const { state } = runLotteryLadder({
    responder: truthfulLadderResponder(3),
    ladder: { maxSteps: 50, lambdaTolerance: 0.5 },
  });
  assert.ok(state.lambdaHi - state.lambdaLo <= 0.5);
  assert.ok(state.step < 50); // stopped on the bracket, not the step cap
});

// --- Signal reconciliation ------------------------------------------------

test('reconcileSignals: agreeing signals tighten the band below any single one', () => {
  const signals = [
    signalFromDrawdown(0.3), // tau 0.6
    signalFromSharpe(0.5), // tau 1/(1+0.5) = 0.667
    signalFromSlider(0.62),
  ];
  const post = reconcileSignals(signals);
  assert.ok(post.tau > 0.55 && post.tau < 0.7);
  // Posterior sigma is below the smallest input sigma (precision adds up).
  const minSigma = Math.min(...signals.map((s) => s.sigma));
  assert.ok(post.sigma < minSigma);
  assert.ok(post.lo < post.tau && post.tau < post.hi);
  // Contribution weights are normalized.
  const wsum = post.contributions.reduce((a, c) => a + c.weight, 0);
  assert.ok(Math.abs(wsum - 1) < 1e-9);
});

test('reconcileSignals: a confident signal dominates a vague one', () => {
  const tight = signalFromSlider(0.8, { sigma: 0.02 });
  const loose = signalFromDrawdown(0.05, { sigma: 0.4 }); // tau 0.1, but very uncertain
  const post = reconcileSignals([tight, loose]);
  assert.ok(post.tau > 0.7, `posterior ${post.tau} should hug the confident 0.8`);
});

test('reconcileSignals: ladder signal carries real weight', () => {
  const { estimate } = runLotteryLadder({ responder: truthfulLadderResponder(1) }); // tau 0.5
  const ladder = signalFromLadder(estimate);
  assert.equal(ladder.source, 'lottery-ladder');
  assert.ok(Math.abs(ladder.tau - 0.5) < 0.05);
  const post = reconcileSignals([ladder, signalFromSlider(0.9)]);
  // The ladder (small sigma) pulls the posterior toward 0.5, away from the slider's 0.9.
  assert.ok(post.tau < 0.75);
});

test('reconcileSignals: empty -> null', () => {
  assert.equal(reconcileSignals([]), null);
  assert.equal(reconcileSignals([{ source: 'x', tau: NaN, sigma: 0.1 }]), null);
});

test('signalFromLottery: a one-shot choice is a weak signal', () => {
  const s = signalFromLottery({ certain: 95, high: 120, low: 80, accepted: true });
  assert.equal(s.source, 'one-shot-lottery');
  assert.ok(s.sigma >= 0.2); // weaker than the ladder
});

// --- Recalibration --------------------------------------------------------

test('recalibrationStatus: fresh, then cadence-elapsed', () => {
  const now = 1_000_000;
  const profile = {
    elicitedAt: now,
    recalibrateAfter: now + DEFAULT_CADENCE_MS,
    confidence: { sigma: 0.05 },
  };
  assert.equal(recalibrationStatus(profile, now).due, false);
  const later = recalibrationStatus(profile, now + DEFAULT_CADENCE_MS + 1);
  assert.equal(later.due, true);
  assert.equal(later.reason, 'cadence-elapsed');
});

test('recalibrationStatus: a too-wide band forces re-elicitation', () => {
  const now = 1_000_000;
  const profile = {
    elicitedAt: now,
    recalibrateAfter: now + DEFAULT_CADENCE_MS,
    confidence: { sigma: 0.3 }, // above DEFAULT_MAX_SIGMA
  };
  const status = recalibrationStatus(profile, now);
  assert.equal(status.due, true);
  assert.equal(status.reason, 'confidence-band-too-wide');
});
