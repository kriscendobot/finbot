import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runLotteryLadder,
  reconcileSignals,
  signalFromLadder,
  signalFromDrawdown,
} from '../elicitation.js';
import { makeVolatilityProfile } from '../profile-store.js';
import {
  renderElicitationIntro,
  renderLotteryQuestion,
  parseLotteryAnswer,
  renderProfileSummary,
  describeTolerance,
} from '../elicitation-ui.js';

test('parseLotteryAnswer: recognizes both sides and synonyms', () => {
  for (const yes of ['B', 'b', 'coin flip', 'gamble', 'risky', 'Bet it']) {
    assert.equal(parseLotteryAnswer(yes), true, yes);
  }
  for (const no of ['A', 'a', 'sure thing', 'safe', 'guaranteed', 'Absolutely']) {
    assert.equal(parseLotteryAnswer(no), false, no);
  }
  for (const bad of ['', '   ', 'maybe', null, undefined]) {
    assert.equal(parseLotteryAnswer(bad), null);
  }
});

test('renderLotteryQuestion: shows both options as percent + dollar on the stake', () => {
  const text = renderLotteryQuestion(
    { step: 0, certain: 0.05, high: 0.3, low: -0.1 },
    { total: 8, stake: 1000 },
  );
  assert.match(text, /Choice 1 \(1 of 8\)/);
  assert.match(text, /\+5%/); // certain return
  assert.match(text, /\$1050\.00/); // certain balance on $1000
  assert.match(text, /\+30%/); // heads
  assert.match(text, /\$1300\.00/);
  assert.match(text, /−10%/); // tails (U+2212 minus)
  assert.match(text, /\$900\.00/);
});

test('UI drives the ladder end-to-end via rendered text + parsed answers', () => {
  // A scripted "user" reading the prompt and replying in words: accept the
  // gamble while the sure thing is a small (fractional) return.
  const replyFor = (question) => (question.certain < 0.04 ? 'B' : 'A');
  const { estimate } = runLotteryLadder({
    responder: (question) => {
      const prompt = renderLotteryQuestion(question);
      assert.match(prompt, /Which do you take/);
      return parseLotteryAnswer(replyFor(question));
    },
  });
  assert.ok(estimate.tau > 0 && estimate.tau < 1);
});

test('describeTolerance: monotone labels across the range', () => {
  assert.equal(describeTolerance(0.1), 'very risk-averse');
  assert.equal(describeTolerance(0.5), 'balanced');
  assert.equal(describeTolerance(0.95), 'aggressive');
});

test('renderProfileSummary: states the tolerance, band, and provenance', () => {
  const { estimate } = runLotteryLadder({ responder: (q) => q.certain < 0.04 });
  const posterior = reconcileSignals([signalFromLadder(estimate), signalFromDrawdown(0.3)]);
  const profile = makeVolatilityProfile({
    userId: 'erin',
    posterior,
    signals: [signalFromLadder(estimate), signalFromDrawdown(0.3)],
    now: 0,
  });
  const summary = renderProfileSummary(profile);
  assert.match(summary, /volatility tolerance is 0\.\d\d/);
  assert.match(summary, /Confidence band/);
  assert.match(summary, /lottery-ladder/);
});

test('renderElicitationIntro: non-empty framing', () => {
  assert.match(renderElicitationIntro(), /comfortable/);
});
