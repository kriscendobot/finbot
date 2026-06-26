/**
 * Terminal / chat surface for the volatility-tolerance elicitation flow — the
 * liaison interaction sketch.
 *
 * These are pure render/parse helpers: they turn a ladder question into a line
 * of prompt text and parse a free-text answer back into the boolean the harness
 * needs. The actual wiring (read a line from a terminal, or post a message into
 * a chat and await the reply) is a thin adapter over `parseLotteryAnswer` +
 * `runLotteryLadder`'s responder contract; keeping the text pure keeps it
 * testable and keeps the UX decisions reviewable in one place.
 *
 * The harness-level inference (`elicitation.js`) is the deliverable; this is the
 * recommended way to drive it from a conversation.
 */

/** Format a number as a dollar amount. */
function usd(x) {
  return `$${Number(x).toFixed(2)}`;
}

/** Format a fractional return as a signed percentage, e.g. 0.3 -> "+30%". */
function pctReturn(x) {
  const pct = Math.round(x * 100); // round first so a tiny -0 doesn't flip the sign
  const sign = pct < 0 ? '−' : '+'; // U+2212 minus
  return `${sign}${Math.abs(pct)}%`;
}

/** A fractional return applied to a stake, rendered as both percent and dollars. */
function outcome(stake, ret) {
  return `${pctReturn(ret)} (${usd(stake * (1 + ret))})`;
}

/** Default notional stake the gamble is framed against in the prompt. */
export const DEFAULT_STAKE = 1000;

/**
 * The opening framing the liaison shows before the ladder begins.
 *
 * @returns {string}
 */
export function renderElicitationIntro() {
  return [
    "Let's calibrate how much volatility you're comfortable with.",
    "I'll offer you a few choices between a sure thing and a coin flip.",
    'There are no wrong answers — just pick the one you would actually prefer.',
  ].join('\n');
}

/**
 * Render one ladder rung as a prompt.
 *
 * Payoffs are fractional returns; they are framed against a notional `stake`
 * (default $1000) and shown as both a percentage and the resulting balance, so
 * the choice reads naturally regardless of the user's actual portfolio size.
 *
 * @param {{step: number, certain: number, high: number, low: number}} question  fractional-return payoffs
 * @param {object} [opts]
 * @param {number} [opts.total]   total rungs, for an "n of N" hint
 * @param {number} [opts.stake]   notional stake the returns apply to (default $1000)
 * @returns {string}
 */
export function renderLotteryQuestion(question, opts = {}) {
  const n = question.step + 1;
  const ofN = opts.total ? ` (${n} of ${opts.total})` : '';
  const stake = opts.stake != null ? opts.stake : DEFAULT_STAKE;
  return [
    `Choice ${n}${ofN}: investing ${usd(stake)} —`,
    `  A) Take a guaranteed ${outcome(stake, question.certain)}.`,
    `  B) Flip a fair coin: heads ${outcome(stake, question.high)}, tails ${outcome(stake, question.low)}.`,
    'Which do you take? [A = sure thing / B = coin flip]',
  ].join('\n');
}

/**
 * Parse a free-text answer to a lottery rung.
 *
 * Accepts the literal options (A/B), and common synonyms for each side. Returns
 * true for "took the gamble" (B / coin flip / risky), false for the certain
 * amount (A / sure thing / safe), and null if the text is unrecognized so the
 * caller can re-ask.
 *
 * @param {string} text
 * @returns {boolean | null}
 */
export function parseLotteryAnswer(text) {
  if (text == null) return null;
  const t = String(text).trim().toLowerCase();
  if (t === '') return null;
  const gamble = ['b', 'coin', 'coin flip', 'flip', 'gamble', 'risk', 'risky', 'bet'];
  const certain = ['a', 'sure', 'sure thing', 'safe', 'certain', 'guaranteed', 'guarantee'];
  if (gamble.includes(t)) return true;
  if (certain.includes(t)) return false;
  // First-letter fallback so "A)" / "B." / "Bet it" still resolve.
  if (t[0] === 'b') return true;
  if (t[0] === 'a') return false;
  return null;
}

/**
 * A human-readable summary of a persisted profile, for the liaison to echo back
 * once elicitation finishes.
 *
 * @param {object} profile   a makeVolatilityProfile() result
 * @returns {string}
 */
export function renderProfileSummary(profile) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const c = profile.confidence || {};
  const label = describeTolerance(profile.tau);
  const lines = [
    `Your volatility tolerance is ${profile.tau.toFixed(2)} (${label}).`,
    `Confidence band: ${pct(c.lo)}–${pct(c.hi)} (±${c.z}σ).`,
  ];
  if (profile.signals && profile.signals.length) {
    const srcs = profile.signals.map((s) => s.source).join(', ');
    lines.push(`Calibrated from: ${srcs}.`);
  }
  return lines.join('\n');
}

/**
 * A coarse natural-language label for a tolerance, for summaries.
 *
 * @param {number} tau
 * @returns {string}
 */
export function describeTolerance(tau) {
  if (tau < 0.2) return 'very risk-averse';
  if (tau < 0.4) return 'cautious';
  if (tau < 0.6) return 'balanced';
  if (tau < 0.8) return 'risk-tolerant';
  return 'aggressive';
}
