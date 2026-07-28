import { test } from 'node:test';
import assert from 'node:assert/strict';

import { project } from '../forecaster.js';
import { audit } from '../auditor.js';
import { hashProposal } from '../planner.js';
import { runOodaCycle } from '../ooda-cycle.js';
import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

// The forecast-data-sufficiency invariant: an opt-in pre-execution gate on how
// far the forecast projects past its observed window. Off by default the
// invariant is not even emitted, so the verdict is byte-identical to before;
// armed, a forecast that outruns its evidence fails the gate, and so does a
// forecast the gate cannot measure at all — an armed gate with no evidence
// fails CLOSED, because this verdict is a precondition for irreversible action.
// This is the pre-execution sibling of pricing-freshness (a forecast can be
// fresh yet thin).

const DIP = [
  10, 10.05, 9.98, 10.02, 9.95, 10.01, 9.9, 9.6,
  9.75, 9.2, 9.55, 8.9, 9.3, 8.85, 9.15, 8.8,
];

function readingsOf(series) {
  return series.map((p, i) => ({ t: i, prices: { ATOM: p } }));
}

function forecastWith(window, config) {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: window[window.length - 1].prices.ATOM },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: window[window.length - 1].prices.ATOM }, volatilities: { ATOM: 0.02 }, drifts: { ATOM: 0 }, seed: 7 },
    seed: 7,
    tag: 'auditor-data-sufficiency',
  });
  return project(
    { world, targetWeights: { ATOM: 0.5 }, readings: window },
    {
      ensembleSize: 8, horizon: config.horizon, baseSeed: 100, render: false,
      reportDataSufficiency: config.reportDataSufficiency !== false,
    },
  );
}

const PROPOSAL = {
  steps: [], proposal_hash: hashProposal([]), cited_forecasts: ['f'], cited_analyses: ['a'],
};
const auditInputFor = (forecast) => ({
  proposal: PROPOSAL, forecast,
  portfolio: { cash: 1000, balances: { ATOM: 0 } }, prices: { ATOM: 10 }, currentTick: 0,
});
const sufficiencyOf = (verdict) =>
  verdict.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');

test('audit: default (min 0) does not emit the invariant — verdict byte-identical', () => {
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const off = audit(auditInputFor(forecast), { tailFloorPct: 0.5 });
  const explicitZero = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 0 });
  assert.deepEqual(off, explicitZero);
  assert.equal(sufficiencyOf(off), undefined);
});

test('audit: gate on, forecast clears coverage -> passes', () => {
  // 16-frame window (15 returns) / 5-tick horizon -> coverage 3.0, well above 1.0.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  const invariant = sufficiencyOf(verdict);
  assert.ok(invariant);
  assert.equal(invariant.pass, true);
  assert.ok(!verdict.failed_invariants.includes('forecast-data-sufficiency'));
  assert.match(invariant.detail, /coverage 3\.000 on ATOM/);
  // A passing invariant never appends a contradicting scarcity claim.
  assert.ok(!/scarce/.test(invariant.detail));
});

test('audit: gate on, forecast below coverage -> rejected', () => {
  // 4-frame window (3 returns) / 20-tick horizon -> coverage 0.15, below 1.0.
  const forecast = forecastWith(readingsOf(DIP.slice(0, 4)), { horizon: 20 });
  const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  const invariant = sufficiencyOf(verdict);
  assert.equal(invariant.pass, false);
  assert.equal(verdict.verdict, 'rejected');
  assert.ok(verdict.failed_invariants.includes('forecast-data-sufficiency'));
  assert.match(invariant.detail, /coverage 0\.150 .* vs required 1\.000/);
});

test('audit: coverage that exactly meets the requirement passes', () => {
  // 4-frame window (3 returns) / 9-tick horizon -> the descriptor reports
  // round12(1/3) = 0.333333333333, which is STRICTLY below the exact 1/3 the
  // operator asked for. Both sides are quantized to the descriptor's own 12
  // decimals precisely to absorb that; without it the gate would reject a
  // forecast that meets its requirement exactly.
  const forecast = forecastWith(readingsOf(DIP.slice(0, 4)), { horizon: 9 });
  assert.equal(forecast.dataSufficiency.coverageRatio, 0.333333333333);
  assert.ok(forecast.dataSufficiency.coverageRatio < 1 / 3);
  const met = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 / 3 });
  assert.equal(sufficiencyOf(met).pass, true);
  // A genuinely higher requirement still bites.
  const missed = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 0.34 });
  assert.equal(sufficiencyOf(missed).pass, false);
});

test('audit: gate on but the forecast carries no descriptor -> fails CLOSED', () => {
  // The forecaster's report left off upstream. The gate cannot show the forecast
  // clears the requirement, so it must not approve: absence of evidence is not
  // evidence of sufficiency.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5, reportDataSufficiency: false });
  assert.equal(forecast.dataSufficiency, null);
  const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  const invariant = sufficiencyOf(verdict);
  assert.equal(invariant.pass, false);
  assert.equal(verdict.verdict, 'rejected');
  assert.match(invariant.detail, /no measurable data-sufficiency descriptor/);
  assert.match(invariant.detail, /fails closed/);
  // Same for a forecast the caller omitted entirely.
  assert.equal(
    sufficiencyOf(audit(auditInputFor(null), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 })).pass,
    false,
  );
});

test('audit: a malformed descriptor fails the gate instead of throwing', () => {
  // `audit()` accepts a caller-supplied forecast (the LLM-facing audit_proposal
  // tool, the executor's fire-time re-audit), so the descriptor is untrusted
  // input. A verdict is owed, not a TypeError out of the auditor.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  for (const malformed of [{}, true, { coverageRatio: 'lots' }, { coverageRatio: NaN }]) {
    const verdict = audit(
      auditInputFor({ ...forecast, dataSufficiency: malformed }),
      { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
    );
    assert.equal(sufficiencyOf(verdict).pass, false, `descriptor ${JSON.stringify(malformed)}`);
  }
  // An Infinity coverage is not finite evidence either.
  const wild = audit(
    auditInputFor({ ...forecast, dataSufficiency: { coverageRatio: Infinity, historyReturns: 0, horizon: 20 } }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
  );
  assert.equal(sufficiencyOf(wild).pass, false);
});

test('audit: a coercible non-number is not coverage evidence', () => {
  // `Number('3')`, `Number([3])`, `Number(true)`, and a `valueOf` hook all yield
  // a number that would clear the requirement, so a coercing read lets a foreign
  // producer forge coverage out of a value that is not a measurement at all. The
  // descriptor is untrusted input; the gate type-checks it, exactly as the
  // forecaster's own price reads do.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  for (const ratio of ['3', [3], true, { valueOf: () => 3 }, 3n]) {
    const verdict = audit(
      auditInputFor({ ...forecast, dataSufficiency: { ...forecast.dataSufficiency, coverageRatio: ratio } }),
      { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
    );
    assert.equal(sufficiencyOf(verdict).pass, false, `coverageRatio ${String(ratio)}`);
    assert.match(sufficiencyOf(verdict).detail, /fails closed/);
  }
});

test('audit: a descriptor that contradicts its own evidence fails CLOSED', () => {
  // The gate decides on coverage it RECOMPUTES from the descriptor's primitive
  // counts, so a producer cannot approve itself by reporting a ratio its own
  // evidence refutes — the sibling discipline invariant 4 applies to the
  // proposal hash. A record that prints its own refutation must never approve.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 }); // 15 returns / 5 ticks
  const forged = audit(
    auditInputFor({
      ...forecast,
      dataSufficiency: { ...forecast.dataSufficiency, coverageRatio: 99, historyReturns: 0 },
    }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
  );
  assert.equal(sufficiencyOf(forged).pass, false);
  assert.equal(forged.verdict, 'rejected');
  assert.match(sufficiencyOf(forged).detail, /recompute to 0\.000/);
  assert.match(sufficiencyOf(forged).detail, /fails closed/);

  // Internally consistent counts that describe a DIFFERENT projection than the
  // forecast carrying them (a stale pre-stretch descriptor riding a longer
  // horizon) are refuted by the forecast's own horizon — a non-adversarial
  // variant of the same hole: 15/5 would clear a 2.0 gate that the real 15/60
  // fails.
  const stale = audit(
    auditInputFor({ ...forecast, horizon: 60 }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 2 },
  );
  assert.equal(sufficiencyOf(stale).pass, false);
  assert.match(sufficiencyOf(stale).detail, /contradicts the forecast's own 60-tick horizon/);
});

test('audit: a hostile descriptor owes a verdict, never a throw', () => {
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const armed = { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 };

  // A getter that throws is still untrusted input; `audit()` returns a rejecting
  // verdict rather than aborting the executor's fire-time drift guard by
  // exception (`runAudit` is called unwrapped there).
  const throwing = audit(
    auditInputFor({ ...forecast, dataSufficiency: { get coverageRatio() { throw new Error('boom'); } } }),
    armed,
  );
  assert.equal(sufficiencyOf(throwing).pass, false);
  assert.match(sufficiencyOf(throwing).detail, /fails closed/);

  // A Symbol threshold would throw inside `Number()`; it is simply unusable.
  const symbolThreshold = audit(
    auditInputFor(forecast),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: Symbol('nope') },
  );
  assert.equal(sufficiencyOf(symbolThreshold).pass, false);

  // Each field is read ONCE: a getter that answers differently on a second read
  // cannot make the detail line cite evidence the gate never saw.
  let reads = 0;
  const flapping = {
    coverageRatio: 3, horizon: 5, worstAsset: 'ATOM',
    get historyReturns() { reads += 1; return reads === 1 ? 15 : 999999; },
  };
  const cited = audit(auditInputFor({ ...forecast, dataSufficiency: flapping }), armed);
  assert.equal(sufficiencyOf(cited).pass, true);
  assert.match(sufficiencyOf(cited).detail, /\(15 observed return\(s\) \/ 5-tick horizon\)/);
});

test('audit: a zero-tick projection cannot outrun its window', () => {
  // Nothing measured is not the same as measured-and-insufficient: coverage 0 on
  // a 0-tick horizon is the descriptor saying "no projection", and the gate must
  // not read it as scarcity the way it reads 0 coverage on a 20-tick horizon.
  const forecast = {
    horizon: 0, p05Equity: 1000,
    dataSufficiency: { coverageRatio: 0, historyReturns: 0, horizon: 0, worstAsset: 'ATOM' },
  };
  const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  assert.equal(sufficiencyOf(verdict).pass, true);
  assert.match(sufficiencyOf(verdict).detail, /projects 0 ticks on ATOM/);
});

test('audit: an unusable threshold arms the gate and fails it closed', () => {
  // A requirement that is non-finite, negative, or not a number at all must not
  // degrade to "no gate at all"; an operator who asked for a gate never silently
  // gets none. `''`, `'  '`, `[]`, and `false` are the dangerous class: every one
  // of them coerces to 0, which is exactly the OFF value, so a coercing read
  // would leave the operator believing in a gate that was never emitted. A
  // positive threshold below the descriptor's own 1e-12 resolution is unusable
  // for the mirror-image reason: no coverage could ever fail it.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 }); // coverage 3.0
  for (const bad of [NaN, 'abc', -1, Infinity, '', '   ', [], false, '1', 1e-13]) {
    const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: bad });
    const invariant = sufficiencyOf(verdict);
    assert.ok(invariant, `threshold ${String(bad)} still emits the invariant`);
    assert.equal(invariant.pass, false, `threshold ${String(bad)} fails closed`);
    assert.match(invariant.detail, /fails closed/);
  }
});

test('ooda-cycle: the lone auditor gate knob auto-enables the report and bites', async () => {
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'data-sufficiency-ooda',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 16; i += 1) sim.tick();

  // windowTicks 10 -> 9 observed returns; a 20-tick horizon -> coverage 0.45,
  // below the 1.0 the operator required. Only the auditor knob is set, so the
  // ooda-cycle must auto-enable the forecaster report to give the gate data.
  const cycleConfig = (forecaster) => ({
    world,
    history: sim.history,
    cycleId: 'data-sufficiency-ooda',
    config: {
      windowTicks: 10,
      oracle: { thresholdBps: 5 },
      analyzer: { scoreFloor: 0 },
      forecaster: { ensembleSize: 8, horizon: 20, baseSeed: 100, ...forecaster },
      bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
      auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11, dataSufficiencyMinCoverage: 1 },
    },
  });

  const result = await runOodaCycle(cycleConfig({}));
  assert.equal(result.walletTouched, false);
  assert.ok(result.forecast.dataSufficiency, 'the gate auto-enabled the forecaster report');
  assert.equal(result.forecast.dataSufficiency.horizon, 20);
  assert.ok(result.audit, 'an armed gate reaches the audit stage');
  const invariant = result.audit.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
  assert.ok(invariant, 'the invariant is emitted when the gate is on');
  assert.equal(invariant.pass, false);
  assert.ok(result.audit.failed_invariants.includes('forecast-data-sufficiency'));

  // An explicit `reportDataSufficiency: false` still wins over the auto-enable —
  // but it can no longer DISARM the gate: with no evidence to read, the armed
  // invariant fails closed rather than approving vacuously.
  const suppressed = await runOodaCycle(cycleConfig({ reportDataSufficiency: false }));
  assert.equal(suppressed.forecast.dataSufficiency, null);
  assert.ok(suppressed.audit, 'an armed gate still reaches the audit stage');
  const suppressedInvariant = suppressed.audit.invariant_results
    .find((r) => r.name === 'forecast-data-sufficiency');
  assert.ok(suppressedInvariant);
  assert.equal(suppressedInvariant.pass, false);
  assert.equal(suppressed.audit.verdict, 'rejected');
});
