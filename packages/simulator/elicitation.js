/**
 * Volatility-tolerance elicitation harness.
 *
 * The risk/reward module (`risk-reward.js`) represents a user's appetite as a
 * single volatility tolerance `tau in [0,1]` and ships deterministic *sketches*
 * for inferring it. This module turns those sketches into a usable elicitation
 * flow: an adaptive lottery ladder that bisects the user's risk-aversion
 * `lambda` and converges to a `tau` with a stated uncertainty, plus a
 * reconciler that folds several independent signals (the ladder, a stated
 * worst-acceptable drawdown, a target Sharpe, a direct slider, a one-shot
 * lottery) into a single posterior `tau` with a confidence band.
 *
 * Everything here is a pure function of its inputs — no clock, no I/O, no
 * randomness. The terminal/chat surface that asks the questions lives in
 * `elicitation-ui.js`; persistence lives in `profile-store.js`; the planner's
 * consumption of a persisted profile lives in `@finbot/pipeline`. A truthful
 * simulated user (`truthfulLadderResponder`) makes the whole ladder testable
 * end to end: bisecting against a known `lambda` recovers it.
 */

import {
  toleranceFromRiskAversion,
  inferToleranceFromMaxDrawdown,
  inferToleranceFromTargetSharpe,
  inferToleranceFromLottery,
} from './risk-reward.js';

/** Clamp a tolerance into the unit interval. */
function clamp01(x) {
  if (x == null || Number.isNaN(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}

// ---------------------------------------------------------------------------
// Adaptive lottery ladder — bisection on risk-aversion lambda.
// ---------------------------------------------------------------------------
//
// Each rung offers a fixed 50/50 gamble (`high` or `low`, each p=0.5) versus a
// *certain* amount we choose. A user with risk-aversion lambda values the
// gamble at its certainty equivalent CE(lambda) = E - (lambda/2)·Var, and so
// accepts the gamble iff CE(their lambda) >= certain. We set the certain amount
// to CE(midpoint of the current lambda bracket); then "took the gamble" means
// their lambda is below the midpoint (narrow the upper bound), and "took the
// certain amount" means it is above (narrow the lower bound). Each answer halves
// the bracket — classic bisection — and the midpoint converges to the user's
// lambda, which `toleranceFromRiskAversion` maps to tau.
//
// Payoffs are expressed as *fractional returns* (e.g. +0.30 = a 30% gain), not
// absolute dollars, so the elicited lambda lives in the same units as
// `risk-reward.js` (where reward/risk are fractional). With the +EV default
// gamble {+0.30, -0.10} and lambdaHi=10, the indifference certain amount stays
// inside the gamble's own [-0.10, +0.30] range across the whole bracket — no
// absurd "guaranteed -$2900" rungs the way a dollar-framed gamble would produce.

const DEFAULT_GAMBLE = { high: 0.3, low: -0.1 };
const DEFAULT_LAMBDA_LO = 0;
// At lambdaHi the indifference certain amount equals `low`: 2·(E−low)/Var = 10.
const DEFAULT_LAMBDA_HI = 10; // tau in [1/11 ≈ 0.091, 1] — a wide, plausible span
const DEFAULT_MAX_STEPS = 8; // 8 halvings of [0,10] -> lambda resolution ~0.039

/** Expected value and variance of a 50/50 {high, low} gamble. */
function gambleMoments(gamble) {
  const e = 0.5 * gamble.high + 0.5 * gamble.low;
  const spread = gamble.high - gamble.low;
  const variance = 0.25 * spread * spread;
  return { e, variance };
}

/** The certainty-equivalent (indifference certain amount) at a given lambda. */
function certainForLambda(gamble, lambda) {
  const { e, variance } = gambleMoments(gamble);
  return e - 0.5 * lambda * variance;
}

/**
 * Begin a lottery ladder.
 *
 * @param {object} [opts]
 * @param {{high: number, low: number}} [opts.gamble]   50/50 payoffs (default {120,80})
 * @param {number} [opts.lambdaLo]      lower bracket on risk-aversion (default 0)
 * @param {number} [opts.lambdaHi]      upper bracket on risk-aversion (default 20)
 * @param {number} [opts.maxSteps]      maximum questions (default 8)
 * @param {number} [opts.lambdaTolerance]  stop early once the bracket is this narrow (default 0)
 * @returns {object}                    opaque ladder state; feed to nextLotteryQuestion / answerLotteryQuestion
 */
export function startLotteryLadder(opts = {}) {
  return {
    gamble: opts.gamble || DEFAULT_GAMBLE,
    lambdaLo: opts.lambdaLo != null ? opts.lambdaLo : DEFAULT_LAMBDA_LO,
    lambdaHi: opts.lambdaHi != null ? opts.lambdaHi : DEFAULT_LAMBDA_HI,
    maxSteps: opts.maxSteps != null ? opts.maxSteps : DEFAULT_MAX_STEPS,
    lambdaTolerance: opts.lambdaTolerance != null ? opts.lambdaTolerance : 0,
    step: 0,
    history: [],
  };
}

/**
 * Has the ladder converged (or run out of questions)?
 *
 * @param {object} state
 * @returns {boolean}
 */
export function ladderDone(state) {
  if (state.step >= state.maxSteps) return true;
  return state.lambdaHi - state.lambdaLo <= state.lambdaTolerance;
}

/**
 * The next question to put to the user, or null if the ladder is done.
 *
 * @param {object} state
 * @returns {{step: number, certain: number, high: number, low: number, expectedValue: number, lambdaMid: number} | null}
 */
export function nextLotteryQuestion(state) {
  if (ladderDone(state)) return null;
  const lambdaMid = 0.5 * (state.lambdaLo + state.lambdaHi);
  const { e } = gambleMoments(state.gamble);
  return {
    step: state.step,
    certain: certainForLambda(state.gamble, lambdaMid),
    high: state.gamble.high,
    low: state.gamble.low,
    expectedValue: e,
    lambdaMid,
  };
}

/**
 * Record an answer and return the next ladder state.
 *
 * @param {object} state
 * @param {boolean} acceptedGamble   true = took the risky gamble, false = took the certain amount
 * @returns {object}                 next state
 */
export function answerLotteryQuestion(state, acceptedGamble) {
  const lambdaMid = 0.5 * (state.lambdaLo + state.lambdaHi);
  // Accepting the gamble means a low risk-aversion: lambda < midpoint.
  const next = {
    ...state,
    step: state.step + 1,
    lambdaLo: acceptedGamble ? state.lambdaLo : lambdaMid,
    lambdaHi: acceptedGamble ? lambdaMid : state.lambdaHi,
    history: state.history.concat([{
      step: state.step,
      certain: certainForLambda(state.gamble, lambdaMid),
      lambdaMid,
      acceptedGamble,
    }]),
  };
  return next;
}

/**
 * The current point estimate and uncertainty implied by a ladder state.
 *
 * tau is decreasing in lambda, so the tau band flips the lambda bracket:
 * tauLo = tolerance(lambdaHi), tauHi = tolerance(lambdaLo). `sigma` treats the
 * residual bracket as roughly uniform (std = width / sqrt(12)) so it can feed
 * the inverse-variance reconciler on the same footing as the other signals.
 *
 * @param {object} state
 * @returns {{lambda: number, lambdaLo: number, lambdaHi: number, tau: number, tauLo: number, tauHi: number, sigma: number, steps: number}}
 */
export function ladderEstimate(state) {
  const lambda = 0.5 * (state.lambdaLo + state.lambdaHi);
  const tau = toleranceFromRiskAversion(lambda);
  const tauLo = toleranceFromRiskAversion(state.lambdaHi);
  const tauHi = toleranceFromRiskAversion(state.lambdaLo);
  const sigma = (tauHi - tauLo) / Math.sqrt(12);
  return {
    lambda,
    lambdaLo: state.lambdaLo,
    lambdaHi: state.lambdaHi,
    tau,
    tauLo,
    tauHi,
    sigma,
    steps: state.step,
  };
}

/**
 * Drive a whole ladder against a `responder` callback (a real UI adapter, or a
 * simulated user in tests). The responder receives each question and returns a
 * boolean: true = took the gamble.
 *
 * @param {object} input
 * @param {(question: object, state: object) => boolean} input.responder
 * @param {object} [input.ladder]    options forwarded to startLotteryLadder
 * @returns {{estimate: object, trace: Array<object>, state: object}}
 */
export function runLotteryLadder(input) {
  let state = startLotteryLadder(input.ladder || {});
  while (!ladderDone(state)) {
    const question = nextLotteryQuestion(state);
    const accepted = Boolean(input.responder(question, state));
    state = answerLotteryQuestion(state, accepted);
  }
  return { estimate: ladderEstimate(state), trace: state.history, state };
}

/**
 * A truthful simulated user with a known risk-aversion. Useful in tests: a
 * bisection against this responder recovers `trueLambda` to ladder resolution.
 *
 * @param {number} trueLambda
 * @returns {(question: object) => boolean}
 */
export function truthfulLadderResponder(trueLambda) {
  // Accept the gamble iff its certainty equivalent at the true lambda beats the
  // offered certain amount — equivalently, iff trueLambda < the rung's midpoint.
  return (question) => trueLambda < question.lambdaMid;
}

// ---------------------------------------------------------------------------
// Signal reconciliation — fold independent observations into one posterior tau.
// ---------------------------------------------------------------------------
//
// Each signal is an observation `{ source, tau, sigma }` of the user's true tau.
// Treating them as independent Gaussians, the posterior mean is the
// precision-weighted (1/sigma²) average and the posterior precision is the sum
// of precisions — the standard inverse-variance combination. A z-scaled band
// around the posterior mean is the stated confidence interval.

const SIGMA_FLOOR = 1e-3; // never divide by zero; a perfectly certain signal is still slightly soft

/** Default per-source uncertainties (std on tau). Coarser inputs are softer. */
export const DEFAULT_SIGNAL_SIGMA = {
  'lottery-ladder': 0.05,
  'max-drawdown': 0.12,
  'target-sharpe': 0.15,
  slider: 0.1,
  'one-shot-lottery': 0.2,
};

/** Build a signal from a finished ladder estimate. */
export function signalFromLadder(estimate, opts = {}) {
  const sigma = Math.max(
    opts.sigma != null ? opts.sigma : estimate.sigma,
    DEFAULT_SIGNAL_SIGMA['lottery-ladder'] * 0.2,
    SIGMA_FLOOR,
  );
  return { source: 'lottery-ladder', tau: clamp01(estimate.tau), sigma };
}

/** Build a signal from a stated worst-acceptable drawdown fraction. */
export function signalFromDrawdown(maxAcceptableDrawdownPct, opts = {}) {
  const tau = inferToleranceFromMaxDrawdown(maxAcceptableDrawdownPct, opts.referenceDrawdown);
  const sigma = Math.max(opts.sigma != null ? opts.sigma : DEFAULT_SIGNAL_SIGMA['max-drawdown'], SIGMA_FLOOR);
  return { source: 'max-drawdown', tau: clamp01(tau), sigma };
}

/** Build a signal from a stated minimum-acceptable Sharpe hurdle. */
export function signalFromSharpe(sharpe, opts = {}) {
  const tau = inferToleranceFromTargetSharpe(sharpe, opts.sharpeRef);
  const sigma = Math.max(opts.sigma != null ? opts.sigma : DEFAULT_SIGNAL_SIGMA['target-sharpe'], SIGMA_FLOOR);
  return { source: 'target-sharpe', tau: clamp01(tau), sigma };
}

/** Build a signal from a direct 0..1 slider. */
export function signalFromSlider(value, opts = {}) {
  const sigma = Math.max(opts.sigma != null ? opts.sigma : DEFAULT_SIGNAL_SIGMA.slider, SIGMA_FLOOR);
  return { source: 'slider', tau: clamp01(value), sigma };
}

/**
 * Build a (weak) signal from a single 50/50 lottery choice. A one-shot choice
 * only bounds tolerance, so we center the observation on the implied bound and
 * keep its sigma wide — the ladder is the strong instrument.
 */
export function signalFromLottery(choice, opts = {}) {
  const { toleranceBound } = inferToleranceFromLottery(choice);
  const sigma = Math.max(opts.sigma != null ? opts.sigma : DEFAULT_SIGNAL_SIGMA['one-shot-lottery'], SIGMA_FLOOR);
  return { source: 'one-shot-lottery', tau: clamp01(toleranceBound), sigma };
}

/**
 * Reconcile independent tau observations into a single posterior.
 *
 * @param {Array<{source: string, tau: number, sigma: number, weight?: number}>} signals
 * @param {object} [opts]
 * @param {number} [opts.z]   band half-width in posterior std units (default 1.96 ≈ 95%)
 * @returns {{tau: number, sigma: number, lo: number, hi: number, z: number, contributions: Array<object>} | null}
 */
export function reconcileSignals(signals, opts = {}) {
  const z = opts.z != null ? opts.z : 1.96;
  const valid = (signals || []).filter(
    (s) => s && Number.isFinite(s.tau) && Number.isFinite(s.sigma) && s.sigma > 0,
  );
  if (valid.length === 0) return null;

  let precisionSum = 0;
  let weightedTau = 0;
  const weights = valid.map((s) => {
    const sigma = Math.max(s.sigma, SIGMA_FLOOR);
    const w = s.weight != null ? s.weight : 1 / (sigma * sigma);
    precisionSum += w;
    weightedTau += w * s.tau;
    return w;
  });

  const tau = clamp01(weightedTau / precisionSum);
  const sigma = Math.sqrt(1 / precisionSum);
  const contributions = valid.map((s, i) => ({
    source: s.source,
    tau: s.tau,
    sigma: s.sigma,
    weight: weights[i] / precisionSum,
  }));
  return {
    tau,
    sigma,
    lo: clamp01(tau - z * sigma),
    hi: clamp01(tau + z * sigma),
    z,
    contributions,
  };
}

// ---------------------------------------------------------------------------
// Re-calibration cadence.
// ---------------------------------------------------------------------------

/** Default re-calibration cadence: 90 days. */
export const DEFAULT_CADENCE_MS = 90 * 24 * 60 * 60 * 1000;

/** Above this posterior std, the band is too wide and we should re-elicit. */
export const DEFAULT_MAX_SIGMA = 0.18;

/**
 * Decide whether a persisted profile is due for re-calibration.
 *
 * @param {object} profile         a persisted volatility profile
 * @param {number} now             current epoch ms (injected; no clock here)
 * @param {object} [opts]
 * @param {number} [opts.maxSigma] band-width trigger (default DEFAULT_MAX_SIGMA)
 * @returns {{due: boolean, reason: string, ageMs: number, sigma: number}}
 */
export function recalibrationStatus(profile, now, opts = {}) {
  const maxSigma = opts.maxSigma != null ? opts.maxSigma : DEFAULT_MAX_SIGMA;
  const elicitedAt = profile && profile.elicitedAt != null ? profile.elicitedAt : 0;
  const sigma = profile && profile.confidence ? profile.confidence.sigma : Infinity;
  const ageMs = now - elicitedAt;

  if (profile && profile.recalibrateAfter != null && now >= profile.recalibrateAfter) {
    return { due: true, reason: 'cadence-elapsed', ageMs, sigma };
  }
  if (sigma > maxSigma) {
    return { due: true, reason: 'confidence-band-too-wide', ageMs, sigma };
  }
  return { due: false, reason: 'fresh', ageMs, sigma };
}
