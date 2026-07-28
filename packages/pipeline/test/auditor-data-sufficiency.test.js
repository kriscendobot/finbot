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
  assert.match(invariant.detail, /no measurable data-sufficiency evidence/);
  // The detail names the FIELD that failed, not merely the artifact that carried
  // it: this is the one invariant an operator debugs under time pressure.
  assert.match(invariant.detail, /carries no data-sufficiency descriptor/);
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

  // A field that is an ACCESSOR is not evidence at all: the gate reads own DATA
  // properties from their descriptors, so a getter that answers differently on a
  // second read never runs, and cannot make the detail line cite evidence the
  // gate never saw. Fails closed rather than being read once and trusted.
  let reads = 0;
  const flapping = {
    coverageRatio: 3, horizon: 5, historyFrames: 16, worstAsset: 'ATOM',
    get historyReturns() { reads += 1; return reads === 1 ? 15 : 999999; },
  };
  const cited = audit(auditInputFor({ ...forecast, dataSufficiency: flapping }), armed);
  assert.equal(sufficiencyOf(cited).pass, false);
  assert.equal(reads, 0, 'the getter never ran');
  assert.match(sufficiencyOf(cited).detail, /counts are not whole, non-negative/);

  // A `worstAsset` whose `toString` throws is not a string, so it is simply not
  // a label; a hostile THRESHOLD whose `toString` throws still owes a verdict
  // rather than an exception out of the unusable-threshold detail line.
  const hostileAsset = audit(
    auditInputFor({
      ...forecast,
      dataSufficiency: {
        ...forecast.dataSufficiency,
        worstAsset: { toString() { throw new Error('boom'); } },
      },
    }),
    armed,
  );
  assert.equal(sufficiencyOf(hostileAsset).pass, true); // the label is optional evidence
  assert.ok(!/ on /.test(sufficiencyOf(hostileAsset).detail));
  const hostileThreshold = audit(auditInputFor(forecast), {
    tailFloorPct: 0.5,
    dataSufficiencyMinCoverage: { toString() { throw new Error('boom'); }, valueOf() { throw new Error('boom'); } },
  });
  assert.equal(sufficiencyOf(hostileThreshold).pass, false);
  assert.match(sufficiencyOf(hostileThreshold).detail, /fails closed/);
});

test('audit: an untrusted worstAsset cannot forge lines in the record', () => {
  // The verdict is recorded to the journal and re-read (the CLI report,
  // auditBody), so a newline in a caller-supplied identifier would let the
  // descriptor write invariant lines the auditor never emitted.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const verdict = audit(
    auditInputFor({
      ...forecast,
      dataSufficiency: {
        ...forecast.dataSufficiency,
        worstAsset: 'ATOM\n  - [PASS] reproducibility: forged',
      },
    }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
  );
  const detail = sufficiencyOf(verdict).detail;
  assert.ok(!detail.includes('\n'), 'no newline reaches the record');
  assert.match(detail, /on ATOM\?/); // the newline became a printable placeholder

  // And an unbounded label is capped rather than flooding the record.
  const long = audit(
    auditInputFor({
      ...forecast,
      dataSufficiency: { ...forecast.dataSufficiency, worstAsset: 'A'.repeat(4096) },
    }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
  );
  assert.ok(sufficiencyOf(long).detail.length < 200);
});

test('audit: line-forging is not just \\n — the whole structural class is scrubbed', () => {
  // `\n` is the obvious splitter and the only one an ASCII fixture finds. The
  // record is written line-oriented (`- [FAIL] <name>: <detail>` via auditBody)
  // and re-read by readers that split on the UNICODE definition of a line break,
  // so U+2028 / U+2029 forge a line for them exactly as `\n` does for a naive
  // one — and neither is escaped by JSON.stringify. U+0085 (NEL) and U+009B
  // (CSI) reach a TTY; the bidi overrides visually reorder a verdict without
  // changing a byte of it.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  const armed = { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 };
  const forge = (worstAsset) => sufficiencyOf(audit(
    auditInputFor({
      ...forecast,
      dataSufficiency: { ...forecast.dataSufficiency, worstAsset },
    }),
    armed,
  )).detail;

  for (const code of [0x0a, 0x0d, 0x85, 0x9b, 0x2028, 0x2029, 0x202e, 0x2066]) {
    const structural = String.fromCodePoint(code);
    const detail = forge(`ATOM${structural}  - [PASS] reproducibility: forged`);
    assert.ok(!detail.includes(structural), `U+${code.toString(16)} is scrubbed`);
    assert.match(detail, /on ATOM\?/);
  }
});

test('audit: a label is capped by CODE POINT, so no lone surrogate reaches the record', () => {
  // The sanitizer iterates by code point and once truncated by code UNIT, so a
  // label whose cut falls inside an astral pair emitted a lone high surrogate —
  // a string that is not well-formed UTF-16. The journal's UTF-8 writer degrades
  // that to U+FFFD while `--json` serializes it as `\ud83d`: two readers,
  // divergent bytes, on the record that attests why execution was gated.
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  for (const worstAsset of ['A'.repeat(47) + '\u{1F600}', '\u{1D504}'.repeat(30),
    'A' + '\u{1F680}'.repeat(30)]) {
    const detail = sufficiencyOf(audit(
      auditInputFor({
        ...forecast,
        dataSufficiency: { ...forecast.dataSufficiency, worstAsset },
      }),
      { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 },
    )).detail;
    assert.ok(detail.isWellFormed(), `well-formed UTF-16 for ${JSON.stringify(worstAsset)}`);
    // Round-tripping through UTF-8 (what the journal writer does) is lossless.
    assert.equal(Buffer.from(detail, 'utf8').toString('utf8'), detail);
  }
});

test('audit: a zero-tick projection has no exemption — the armed gate has NO unconditional pass', () => {
  // A zero-tick horizon once passed unconditionally, on the reasoning that a
  // projection of no ticks cannot outrun its window. True, and beside the point:
  // `forecast.horizon` and `dataSufficiency.horizon` are two fields of the SAME
  // caller-supplied object, so a zero corroborated only by its own neighbour is
  // an assertion, not evidence. A hand-built forecast through audit_proposal /
  // simulate_execution then cleared a demand for FULL coverage — and cleared
  // tail-risk-floor beside it, since p05Equity is self-reported too — having
  // simulated nothing. A zero-tick projection is absence of evidence, and this
  // gate refuses absent evidence.
  const zeroTick = {
    coverageRatio: 0, historyReturns: 0, historyFrames: 0, horizon: 0, worstAsset: 'ATOM',
  };
  const armed = { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 };
  const verdict = audit(
    auditInputFor({ horizon: 0, p05Equity: 1000, dataSufficiency: zeroTick }),
    armed,
  );
  assert.equal(sufficiencyOf(verdict).pass, false);
  assert.equal(verdict.verdict, 'rejected');
  assert.match(sufficiencyOf(verdict).detail, /coverage 0\.000 on ATOM/);
  assert.match(sufficiencyOf(verdict).detail, /vs required 1\.000/);

  // A forecast whose own horizon cannot be read is refuted one step earlier, so
  // the descriptor's self-consistency never gets to speak for it.
  for (const horizon of [undefined, null, '20', NaN, Infinity, 2.5, -0.5]) {
    const bypass = audit(
      auditInputFor({ horizon, p05Equity: 1000, dataSufficiency: zeroTick }),
      armed,
    );
    assert.equal(sufficiencyOf(bypass).pass, false, `forecast.horizon ${String(horizon)}`);
    assert.match(sufficiencyOf(bypass).detail, /fails closed/);
  }
  // And a forecast that genuinely projects 20 ticks refutes the descriptor.
  const contradicted = audit(
    auditInputFor({ horizon: 20, p05Equity: 1000, dataSufficiency: zeroTick }),
    armed,
  );
  assert.equal(sufficiencyOf(contradicted).pass, false);
  assert.match(sufficiencyOf(contradicted).detail, /contradicts the forecast's own 20-tick horizon/);

  // The exemption is gone only while the gate is ARMED. With the gate off, a
  // zero-tick forecast is not judged at all — the invariant is not emitted, and
  // the default verdict path is untouched.
  const off = audit(auditInputFor({ horizon: 0, p05Equity: 1000, dataSufficiency: zeroTick }), {
    tailFloorPct: 0.5,
  });
  assert.equal(sufficiencyOf(off), undefined);
  assert.ok(!off.failed_invariants.includes('forecast-data-sufficiency'));
  assert.equal(off.invariant_results.length, 6);
});

test('audit: the CLI cannot disarm the gate through a malformed horizon', () => {
  // End to end through the producer: a horizon that is not a tick count yields
  // an UNMEASURABLE descriptor (horizon null), which the armed gate reads as no
  // evidence — not as a 0-tick projection that cannot outrun its window.
  const forecast = forecastWith(readingsOf(DIP), { horizon: NaN });
  assert.equal(forecast.dataSufficiency.horizon, null);
  const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 });
  assert.equal(sufficiencyOf(verdict).pass, false);
  // The descriptor's counts are sound; it is the FORECAST's horizon that is not
  // a tick count, and the detail says so rather than blaming the descriptor.
  assert.match(sufficiencyOf(verdict).detail, /the forecast's own horizon/);
  assert.match(sufficiencyOf(verdict).detail, /fails closed/);
});

test('audit: evidence must be OWN evidence, never inherited', () => {
  // A fail-closed gate that reads through the prototype chain is not fail-closed:
  // one polluted `Object.prototype.dataSufficiency` (or a descriptor built with
  // `Object.create`) turns "carries no descriptor, so reject" into "inherits a
  // passing one, so approve" — the substitution the gate exists to refuse, and
  // the same own-property discipline the forecaster applies when producing it.
  const honest = {
    coverageRatio: 3, historyReturns: 15, historyFrames: 16, horizon: 5, worstAsset: 'ATOM',
  };
  const armed = { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 };

  const inheritedFields = audit(
    auditInputFor({ horizon: 5, p05Equity: 1e9, dataSufficiency: Object.create(honest) }),
    armed,
  );
  assert.equal(sufficiencyOf(inheritedFields).pass, false);

  const inheritedDescriptor = audit(
    auditInputFor(Object.create({ dataSufficiency: honest }, {
      horizon: { value: 5, enumerable: true },
      p05Equity: { value: 1e9, enumerable: true },
    })),
    armed,
  );
  assert.equal(sufficiencyOf(inheritedDescriptor).pass, false);

  // The same fields as OWN properties are honest evidence and pass.
  const own = audit(
    auditInputFor({ horizon: 5, p05Equity: 1e9, dataSufficiency: { ...honest } }),
    armed,
  );
  assert.equal(sufficiencyOf(own).pass, true);
});

test('audit: forged coverage is refuted by the descriptor it rides on', () => {
  // The repro descriptors the panel cited. Each is a producer trying to approve
  // itself; the gate decides on the coverage it RECOMPUTES, and refuses evidence
  // that refutes itself — a gate that rejects ABSENT evidence must reject
  // CONTRADICTORY evidence at least as firmly, never approve it.
  const armed = { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 };
  const forged = [
    // the ratio contradicts the counts it claims to summarize
    { coverageRatio: 5, historyReturns: 0, historyFrames: 1, horizon: 100 },
    { coverageRatio: 1.02, historyReturns: 20, historyFrames: 21, horizon: 20 },
    // counts that contradict EACH OTHER: 100 returns cannot come from 0 frames
    { coverageRatio: 5, historyReturns: 100, historyFrames: 0, horizon: 20 },
    { coverageRatio: 5, historyReturns: 100, historyFrames: 2, horizon: 20 },
    // counts that are not counts: 1e-13 returns over a 1e-13-tick horizon
    // recomputes to a clean 1.0 while measuring nothing at all
    { coverageRatio: 1, historyReturns: 1e-13, historyFrames: 1e-12, horizon: 1e-13 },
    { coverageRatio: 1.02, historyReturns: 20.4, historyFrames: 21, horizon: 20 },
    // a descriptor missing the frames count carries no measurable evidence
    { coverageRatio: 5, historyReturns: 100, horizon: 20 },
    { coverageRatio: 5, historyReturns: 0, horizon: 100 },
  ];
  for (const dataSufficiency of forged) {
    const verdict = audit(
      auditInputFor({ horizon: dataSufficiency.horizon, p05Equity: 1e9, dataSufficiency }),
      armed,
    );
    assert.equal(sufficiencyOf(verdict).pass, false, JSON.stringify(dataSufficiency));
    assert.equal(verdict.verdict, 'rejected');
    assert.match(sufficiencyOf(verdict).detail, /fails closed/);
  }
});

test('audit: a count that is not a whole number is not a count, and only that refutes it', () => {
  // The integrality requirement is load-bearing on its own, not a spare tyre for
  // the other two contradiction branches. This descriptor clears every one of
  // them — it recomputes EXACTLY (10.5 / 20 === 0.525), 10.5 is well under
  // `historyFrames - 1` (20), and the two horizons agree — so relaxing
  // `wholeCount` to a mere finiteness check would let an armed 0.5 gate APPROVE
  // live execution on "10.5 observed returns", which is not a count of anything.
  const fractional = {
    coverageRatio: 0.525, historyReturns: 10.5, historyFrames: 21, horizon: 20,
  };
  const verdict = audit(
    auditInputFor({ horizon: 20, p05Equity: 1e9, dataSufficiency: fractional }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 0.5 }, // 0.525 would CLEAR this
  );
  assert.equal(sufficiencyOf(verdict).pass, false);
  assert.equal(verdict.verdict, 'rejected');
  assert.match(sufficiencyOf(verdict).detail, /counts are not whole, non-negative/);

  // The same shape with whole counts is honest evidence and passes, so the
  // fixture above is pinning integrality and nothing else.
  const whole = audit(
    auditInputFor({
      horizon: 20,
      p05Equity: 1e9,
      dataSufficiency: {
        coverageRatio: 0.5, historyReturns: 10, historyFrames: 21, horizon: 20,
      },
    }),
    { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 0.5 },
  );
  assert.equal(sufficiencyOf(whole).pass, true);
});

test('audit: a hostile PROXY owes a verdict, not an exception', () => {
  // The accessor tests cover an own getter; a Proxy is a distinct interception
  // point — `getOwnPropertyDescriptor` and `ownKeys` traps are what the gate's
  // reads actually go through, and an unguarded one would THROW out of `audit()`
  // on the executor's unwrapped fire-time re-audit path rather than rejecting.
  const armed = { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 };
  const honest = {
    coverageRatio: 3, historyReturns: 15, historyFrames: 16, horizon: 5, worstAsset: 'ATOM',
  };
  const trap = () => { throw new Error('boom'); };

  // A hostile descriptor.
  const hostileDescriptor = new Proxy({ ...honest }, { getOwnPropertyDescriptor: trap });
  const a = audit(
    auditInputFor({ horizon: 5, p05Equity: 1e9, dataSufficiency: hostileDescriptor }),
    armed,
  );
  assert.equal(sufficiencyOf(a).pass, false);
  assert.match(sufficiencyOf(a).detail, /fails closed/);

  // A hostile forecast: even reaching the descriptor throws.
  const hostileForecast = new Proxy(
    { horizon: 5, p05Equity: 1e9, dataSufficiency: { ...honest } },
    { getOwnPropertyDescriptor: trap },
  );
  const b = audit(auditInputFor(hostileForecast), armed);
  assert.equal(b.verdict, 'rejected');
  assert.equal(sufficiencyOf(b).pass, false);
});

test('audit: a hostile forecast owes a verdict from EVERY invariant, not just the gate', () => {
  // Invariant 3 formats `forecast.p05Equity`; a caller-supplied forecast that
  // carries no finite p05 (the `audit_proposal` tool, the executor's unwrapped
  // fire-time re-audit) must reject, not throw a TypeError out of `audit()`
  // before the data-sufficiency gate is ever reached.
  for (const forecast of [{}, 0, 'x', true, [], { p05Equity: null }, { p05Equity: '1e9' },
    { p05Equity: NaN }, { dataSufficiency: { coverageRatio: 3, historyReturns: 15, historyFrames: 16, horizon: 5 } }]) {
    for (const config of [{ tailFloorPct: 0.5 }, { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1 }]) {
      const verdict = audit(auditInputFor(forecast), config);
      assert.equal(typeof verdict.verdict, 'string', JSON.stringify(forecast));
      assert.equal(verdict.verdict, 'rejected');
      assert.ok(verdict.failed_invariants.includes('tail-risk-floor'));
    }
  }
});

test('audit: the threshold is OFF only when absent, null, or the number 0', () => {
  const forecast = forecastWith(readingsOf(DIP), { horizon: 5 });
  for (const off of [undefined, null, 0]) {
    const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: off });
    assert.equal(sufficiencyOf(verdict), undefined, `threshold ${String(off)} is OFF`);
  }
  // The usability boundary is the descriptor's own 1e-12 resolution.
  const usable = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 1e-12 });
  assert.equal(sufficiencyOf(usable).pass, true);
  // Printed at a resolution that can still be told apart from the OFF value: a
  // flat toFixed(3) rendered an armed 1e-12 requirement as `required 0.000`,
  // indistinguishable from the 0 that means no gate at all.
  assert.match(sufficiencyOf(usable).detail, /vs required 1\.000e-12/);
  assert.ok(!/vs required 0\.000/.test(sufficiencyOf(usable).detail));
  // The boundary is where `round12` rounds UP, which is just above 5e-13 — not
  // 1e-12, the value the prose used to name. Pinned on both sides so the claim
  // and the arithmetic cannot drift apart again.
  assert.equal(
    sufficiencyOf(audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 5e-13 })).detail
      .includes('fails closed'),
    true,
    '5e-13 quantizes to 0 and is unusable',
  );
  assert.equal(
    sufficiencyOf(audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: 6e-13 })).pass,
    true,
    '6e-13 quantizes to 1e-12 and is usable',
  );
  for (const unusable of [4e-13, 5e-13, Number.MIN_VALUE]) {
    const verdict = audit(auditInputFor(forecast), { tailFloorPct: 0.5, dataSufficiencyMinCoverage: unusable });
    assert.equal(sufficiencyOf(verdict).pass, false, `threshold ${String(unusable)}`);
    assert.match(sufficiencyOf(verdict).detail, /fails closed/);
  }
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

test('ooda-cycle: a malformed threshold still enables the evidence, and never throws', async () => {
  // The cycle's auto-enable predicate MIRRORS the auditor's arming test and must
  // read the threshold STRICTLY: `Number(Symbol())` throws, and `Number('')` is
  // 0 — the OFF value — so a coercing read would either abort the cycle or
  // silently disarm a gate the operator believes is armed. The claim is stated
  // in a comment there; this is the assertion that keeps it true.
  const world = makeWorld({
    portfolio: { cash: 1000, balances: { ATOM: 50 }, initialPrice: 10 },
    priceFeed: { kind: 'gbm', initialPrices: { ATOM: 10 }, volatilities: { ATOM: 0.05 }, drifts: { ATOM: -0.2 }, seed: 7 },
    seed: 7,
    tag: 'data-sufficiency-strict-read',
  });
  const sim = runSimulator(world);
  for (let i = 0; i < 16; i += 1) sim.tick();

  for (const threshold of [Symbol('nope'), '', [], false, 'abc']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runOodaCycle({
      world,
      history: sim.history,
      cycleId: 'data-sufficiency-strict-read',
      config: {
        windowTicks: 10,
        oracle: { thresholdBps: 5 },
        analyzer: { scoreFloor: 0 },
        forecaster: { ensembleSize: 8, horizon: 20, baseSeed: 100 },
        bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
        auditor: { tailFloorPct: 0.5, stalenessWindowTicks: 11, dataSufficiencyMinCoverage: threshold },
      },
    });
    assert.equal(result.walletTouched, false);
    assert.ok(result.forecast.dataSufficiency, `threshold ${String(threshold)} still enables the evidence`);
    const invariant = result.audit.invariant_results.find((r) => r.name === 'forecast-data-sufficiency');
    assert.ok(invariant, `threshold ${String(threshold)} still emits the invariant`);
    assert.equal(invariant.pass, false);
    assert.equal(result.audit.verdict, 'rejected');
  }
});
