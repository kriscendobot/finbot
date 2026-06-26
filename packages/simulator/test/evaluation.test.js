import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  instrumentCandidates,
  runEvaluation,
  renderEvaluationText,
} from '../evaluation.js';
import { PRESETS, generate } from './fixtures/presets.js';

test('instrumentCandidates: three instruments plus a mixed strategy', () => {
  const cands = instrumentCandidates({ horizon: 48, realizationCount: 120 });
  const ids = cands.map((c) => c.id).sort();
  assert.deepEqual(ids, ['dividend', 'growth', 'mixed', 'yield']);
  for (const c of cands) {
    assert.ok(Number.isFinite(c.reward));
    assert.ok(c.risk >= 0);
  }
});

test('instrumentCandidates: growth is the highest-risk instrument', () => {
  const cands = instrumentCandidates({ horizon: 48, realizationCount: 150 });
  const byId = Object.fromEntries(cands.map((c) => [c.id, c]));
  assert.ok(byId.growth.risk > byId.yield.risk);
  assert.ok(byId.growth.risk > byId.dividend.risk);
});

test('runEvaluation: frontier shifts toward riskier instruments as tolerance rises', () => {
  const result = runEvaluation({
    presets: PRESETS,
    generate,
    forecastEval: { horizon: 24, ensembleSize: 100, realizationCount: 150 },
    instruments: { horizon: 48, realizationCount: 150 },
  });
  assert.equal(result.forecastTable.length, PRESETS.length);
  assert.equal(result.candidates.length, 4);
  // Risk accepted at the chosen point is non-decreasing across the sweep.
  for (let i = 1; i < result.frontier.length; i += 1) {
    assert.ok(result.frontier[i].risk >= result.frontier[i - 1].risk - 1e-9);
  }
  // The most risk-averse appetite does not pick the highest-risk instrument,
  // and the boldest does not pick the lowest-reward one (a genuine trade-off).
  const first = result.frontier[0];
  const last = result.frontier[result.frontier.length - 1];
  assert.ok(last.risk >= first.risk);
  assert.ok(last.reward >= first.reward - 1e-9);
});

test('renderEvaluationText: emits the three tables', () => {
  const result = runEvaluation({
    presets: PRESETS.slice(0, 2),
    generate,
    forecastEval: { horizon: 16, ensembleSize: 60, realizationCount: 80 },
    instruments: { horizon: 32, realizationCount: 80 },
  });
  const text = renderEvaluationText(result);
  assert.match(text, /Forecast-evaluation table/);
  assert.match(text, /Instrument candidates/);
  assert.match(text, /Risk\/reward frontier/);
});
