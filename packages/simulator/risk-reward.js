/**
 * Risk/reward balance under a user's volatility tolerance.
 *
 * The objective is not max return and not min risk, but the *balance* the
 * user's tolerance implies. We model that with mean-variance certainty
 * equivalence — the canonical, testable form:
 *
 *   CE(strategy) = reward - (lambda / 2) * risk^2
 *
 * where `reward` is expected return, `risk` is its standard deviation, and
 * `lambda` is a risk-aversion coefficient derived from the user's
 * volatility tolerance tau in [0, 1] (0 = maximally risk-averse, 1 =
 * maximally risk-seeking). A high tolerance => low lambda => the score
 * tilts toward reward; a low tolerance => high lambda => the score tilts
 * toward low risk. Sweeping tau traces the risk/reward frontier: which
 * strategy a given appetite selects, and the (risk, reward) it accepts.
 *
 * Eliciting tau is a UX concern; this module ships a deterministic sketch
 * (from a stated worst-acceptable drawdown, or from a single lottery
 * choice) — enough to drive the evaluation. The full elicitation UX is a
 * follow-on.
 */

/** Clamp tau into the open interval the lambda map is defined on. */
function clampTolerance(tau) {
  if (tau == null || Number.isNaN(tau)) return 0.5;
  return Math.min(0.99, Math.max(0.01, tau));
}

/**
 * Risk-aversion lambda from volatility tolerance.
 *
 *   lambda(tau) = (1 - tau) / tau
 *
 * tau=0.5 -> lambda=1 (balanced); tau->1 -> lambda->0 (reward-seeking);
 * tau->0 -> lambda large (risk-averse). Monotone decreasing in tau.
 *
 * @param {number} tau                  volatility tolerance in [0,1]
 * @returns {number}                    lambda >= 0
 */
export function riskAversionFromTolerance(tau) {
  const t = clampTolerance(tau);
  return (1 - t) / t;
}

/**
 * Inverse map: the tolerance implied by a risk-aversion lambda.
 *
 *   tau = 1 / (1 + lambda)
 *
 * @param {number} lambda
 * @returns {number}                    tau in (0,1)
 */
export function toleranceFromRiskAversion(lambda) {
  const l = Math.max(0, lambda);
  return 1 / (1 + l);
}

/**
 * Certainty-equivalent score of a strategy under a tolerance.
 *
 * @param {{reward: number, risk: number}} strat   reward=expected return, risk=stddev of return
 * @param {number} tau                             volatility tolerance
 * @returns {number}
 */
export function riskRewardScore(strat, tau) {
  const lambda = riskAversionFromTolerance(tau);
  const risk = strat.risk || 0;
  return strat.reward - 0.5 * lambda * risk * risk;
}

/**
 * Reward / risk summary of a sample of returns.
 *
 * @param {number[]} returns            per-realization total returns (fractional)
 * @param {object} [opts]
 * @param {number} [opts.threshold]     downside threshold, default 0 (returns below it are "loss")
 * @returns {{reward: number, risk: number, downside: number, worstLoss: number, n: number}}
 */
export function rewardRiskOf(returns, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0;
  const n = returns.length;
  if (n === 0) return { reward: 0, risk: 0, downside: 0, worstLoss: 0, n: 0 };
  const reward = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((acc, r) => acc + (r - reward) * (r - reward), 0) / n;
  // Downside semi-deviation against the threshold.
  let downAcc = 0;
  let worstLoss = 0;
  for (const r of returns) {
    if (r < threshold) downAcc += (threshold - r) * (threshold - r);
    if (r < worstLoss) worstLoss = r;
  }
  return {
    reward,
    risk: Math.sqrt(variance),
    downside: Math.sqrt(downAcc / n),
    worstLoss,
    n,
  };
}

/**
 * Choose the strategy that maximizes the tolerance-adjusted score.
 *
 * @param {Array<{id: string, reward: number, risk: number}>} candidates
 * @param {number} tau
 * @returns {{chosen: object, scored: Array<object>}}
 */
export function chooseStrategy(candidates, tau) {
  const scored = candidates
    .map((c) => ({ ...c, score: riskRewardScore(c, tau) }))
    .sort((a, b) => b.score - a.score);
  return { chosen: scored[0], scored };
}

/**
 * Sweep volatility tolerance and report which strategy each appetite
 * selects and the (risk, reward) it accepts — the trade-off frontier.
 *
 * @param {object} input
 * @param {Array<{id: string, reward: number, risk: number}>} input.candidates
 * @param {number[]} [input.tolerances]   default 0.1..0.9 step 0.1
 * @returns {Array<{tolerance: number, lambda: number, chosenId: string, reward: number, risk: number, score: number}>}
 */
export function toleranceFrontier(input) {
  const tolerances = input.tolerances
    || [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  return tolerances.map((tau) => {
    const { chosen } = chooseStrategy(input.candidates, tau);
    return {
      tolerance: tau,
      lambda: riskAversionFromTolerance(tau),
      chosenId: chosen.id,
      reward: chosen.reward,
      risk: chosen.risk,
      score: chosen.score,
    };
  });
}

/**
 * Elicitation sketch #1: infer tolerance from a stated worst-acceptable
 * drawdown. A user who can stomach a 50%+ peak-to-trough loss is maximally
 * tolerant; one who can stomach none is maximally averse. Monotone.
 *
 * @param {number} maxAcceptableDrawdownPct   fraction, e.g. 0.2 for 20%
 * @param {number} [referenceDrawdown]        the drawdown that maps to tau=1 (default 0.5)
 * @returns {number}                          tau in [0,1]
 */
export function inferToleranceFromMaxDrawdown(maxAcceptableDrawdownPct, referenceDrawdown = 0.5) {
  const dd = Math.max(0, maxAcceptableDrawdownPct || 0);
  return Math.min(1, dd / referenceDrawdown);
}

/**
 * Elicitation sketch #2: infer a tolerance bound from a single 50/50
 * lottery choice. The user is offered a certain amount `certain` versus a
 * gamble paying `high` or `low` each with probability 0.5. Accepting the
 * gamble reveals an upper bound on risk-aversion (a lower bound on
 * tolerance): the lambda at which the user is indifferent solves
 *
 *   E[gamble] - (lambda/2) Var[gamble] = certain
 *   => lambda* = 2 (E - certain) / Var
 *
 * If the user accepted the gamble their lambda is at most lambda*, so their
 * tolerance is at least tau(lambda*). If they declined, at most.
 *
 * @param {object} choice
 * @param {number} choice.certain
 * @param {number} choice.high
 * @param {number} choice.low
 * @param {boolean} choice.accepted     did the user take the gamble?
 * @returns {{lambdaStar: number, toleranceBound: number, kind: 'lower'|'upper'}}
 */
export function inferToleranceFromLottery(choice) {
  const e = 0.5 * choice.high + 0.5 * choice.low;
  const variance = 0.25 * (choice.high - choice.low) * (choice.high - choice.low);
  const lambdaStar = variance > 0 ? (2 * (e - choice.certain)) / variance : 0;
  const toleranceBound = toleranceFromRiskAversion(Math.max(0, lambdaStar));
  return {
    lambdaStar,
    toleranceBound,
    // Accepting the gamble bounds tolerance from below; declining, from above.
    kind: choice.accepted ? 'lower' : 'upper',
  };
}

/**
 * Elicitation sketch #3: infer tolerance from a stated *minimum acceptable*
 * Sharpe ratio (a reward-per-unit-risk hurdle). A higher hurdle reveals a
 * more demanding, more risk-averse user: in the mean-variance frame a
 * required Sharpe acts exactly like a unit of risk aversion, so we map it
 * through the same `1 / (1 + lambda)` curve with `lambda = sharpe / ref`:
 *
 *   tau = 1 / (1 + sharpe / sharpeRef)
 *
 * sharpe=0 -> tau=1 (will accept any risk), sharpe=sharpeRef -> tau=0.5,
 * sharpe -> infinity -> tau -> 0. Monotone decreasing.
 *
 * @param {number} sharpe                required Sharpe ratio (>= 0)
 * @param {number} [sharpeRef]           the hurdle that maps to tau=0.5 (default 1)
 * @returns {number}                     tau in (0,1]
 */
export function inferToleranceFromTargetSharpe(sharpe, sharpeRef = 1) {
  const s = Math.max(0, sharpe || 0);
  const ref = sharpeRef > 0 ? sharpeRef : 1;
  return toleranceFromRiskAversion(s / ref);
}
