import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// Regressions for the PR #6 round-3 panel's observed-window must-fix bundle.
// Each test reddens if the guard it pins is reverted:
//
//   M3  `windowTicks: 0` off the gate is the DEFAULT window (byte-identical to
//       origin/main's `|| 10`); armed, an explicit 0 is honored as empty.
//   M4  a truthy-but-invalid fitWindowTicks under an armed gate fails closed
//       (the fitWindowTicksValid guard bounds 15.5 / an unsafe integer).

function buildWorldHistory(tag) {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag,
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 20; i += 1) sim.tick();
  return { world, history: sim.history };
}
const OFF_CONFIG = {
  oracle: { thresholdBps: 5 },
  analyzer: { scoreFloor: 0 },
  forecaster: { ensembleSize: 8, horizon: 5, baseSeed: 100, adaptiveVol: { kind: 'garch' } },
  bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
  auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 21 }, // no dataSufficiencyMinCoverage → gate OFF
};
const armedAuditor = (extra) => ({ ...OFF_CONFIG.auditor, dataSufficiencyMinCoverage: 0.5, ...extra });

test('M3: windowTicks 0 off the gate is the default window (byte-identical), not empty', async () => {
  const a = buildWorldHistory('r3-zero-off');
  const zero = await runOodaCycle({
    world: a.world, history: a.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 0 },
  });
  const b = buildWorldHistory('r3-zero-off');
  const defaulted = await runOodaCycle({
    world: b.world, history: b.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 10 }, // the `|| 10` coercion
  });
  // Off the gate, `0` reproduces origin/main's `windowTicks || 10`: the default
  // 10-frame window, NOT an empty one that would flip the cycle to no-opportunity.
  assert.deepEqual(zero, defaulted);
  if (zero.forecast) assert.equal(zero.forecast.volFit.frames, 10, 'the observed window is the default 10');
});

test('M3: windowTicks 0 under an armed gate is honored as an empty window', async () => {
  const w = buildWorldHistory('r3-zero-on');
  const res = await runOodaCycle({
    world: w.world, history: w.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 0, auditor: armedAuditor() },
  });
  // Armed, an explicit 0 is honored verbatim: an empty observed window → no
  // oracle crossings → no-opportunity, rather than defaulting to 10.
  assert.equal(res.outcome, 'no-opportunity');
  assert.equal(res.forecast, null);
});

test('M4: a truthy-but-invalid fitWindowTicks under an armed gate fails the window closed', async () => {
  const w = buildWorldHistory('r3-frac-fit');
  const res = await runOodaCycle({
    world: w.world, history: w.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 10, fitWindowTicks: 15.5, auditor: armedAuditor() },
  });
  // 15.5 is truthy but not a whole tick count. Without the fitWindowTicksValid
  // guard it would slice a 16-frame vol-fit window and the cycle would proceed;
  // with it, the whole window collapses to empty and fails closed.
  assert.equal(res.outcome, 'no-opportunity');
  assert.equal(res.forecast, null);
});

test('M4: an unsafe-integer fitWindowTicks under an armed gate fails the window closed', async () => {
  const w = buildWorldHistory('r3-unsafe-fit');
  const res = await runOodaCycle({
    world: w.world, history: w.history, cycleId: 'id',
    config: { ...OFF_CONFIG, windowTicks: 10, fitWindowTicks: Number.MAX_SAFE_INTEGER + 2, auditor: armedAuditor() },
  });
  assert.equal(res.outcome, 'no-opportunity');
  assert.equal(res.forecast, null);
});
