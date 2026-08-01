---
created: 2026-06-17
updated: 2026-07-28
author: architect
---

# Skill: pre-execution-audit

The auditor's canonical procedure. Apply the invariant set to a planner proposal; emit a signed-off `result` entry on success, a rejection naming the failed invariants on failure. Used by the [auditor](../../roles/auditor/AGENT.md) role; the executor re-runs the same invariants at fire time per its operating norms.

## Purpose

Define the invariant set and the verification procedure for each invariant. Centralizing the invariants here (rather than scattering them across the auditor role file and the executor role file) makes them evolve as one unit: a new invariant lands here, and both consumers pick it up the next time they run.

## Invariants

Initial set (the maintainer will grow this):

### 1. Citation completeness

Every step in the proposal's `steps` list carries `justifies_with` referencing at least one entry in `cited_forecasts` and at least one in `cited_analyses`.

```pseudo
for step in proposal.steps:
  assert step.justifies_with intersects cited_forecasts
  assert step.justifies_with intersects cited_analyses
```

### 2. Risk-bound compliance

Per-step and cumulative-day risk bounds:

```pseudo
nav = sum(current_balances * current_prices)
for step in proposal.steps:
  step_pct_nav = abs(step.amount) / nav * 100
  assert step_pct_nav <= proposal.risk_bounds.per_step_max_pct_nav

cumulative_pct_nav_today = sum_of_today_steps_pct_nav + proposal_pct_nav
assert cumulative_pct_nav_today <= proposal.risk_bounds.per_day_max_pct_nav

for instrument in expected_post_state:
  instrument_pct_nav = expected_post_state[instrument] / nav * 100
  assert instrument_pct_nav <= proposal.risk_bounds.per_instrument_concentration_cap_pct
```

### 3. Tail-risk floor

Every cited forecast's p05 terminal value clears the configured floor:

```pseudo
for forecast_ref in proposal.cited_forecasts:
  forecast = read_journal(forecast_ref)
  p05_pct = forecast.quantiles.p05_terminal_pct
  assert p05_pct >= configured_tail_risk_floor_pct
```

### 4. Reproducibility (hash match)

Recompute the proposal hash and verify it matches the planner's named hash:

```pseudo
recomputed = sha256(canonical_json(proposal_body without proposal_hash))
assert recomputed == proposal.proposal_hash
```

### 5. Pricing freshness

Every cited oracle reading is within the configured staleness window:

```pseudo
for oracle_ref in proposal.cited_oracle_readings:
  reading = read_journal(oracle_ref)
  age_ticks = current_tick - reading.tick
  assert age_ticks <= configured_staleness_window_ticks
```

### 6. On-chain verifiability

Every step's preconditions reference only chain state or cited oracle readings:

```pseudo
for step in proposal.steps:
  for precondition in step.preconditions:
    assert precondition.kind in { 'chain_balance', 'chain_state', 'oracle_reading' }
```

The deterministic implementation names this invariant `place-route-reachability`
and verifies the same property from the step's resolved place/route: a step whose
venue mapping is unresolved (or names an unknown place) is not reachable from
chain state alone.

### 7. Forecast data-sufficiency (opt-in)

A projection whose horizon outruns its observed window is extrapolating past its
evidence. The pre-execution sibling of pricing freshness: a forecast can be
perfectly fresh and still be thin. The forecast carries a measured descriptor
(`{ historyFrames, historyReturns, worstAsset, horizon, coverageRatio }`);
coverage is observed returns per projected tick, measured PER ASSET and reported
for the WORST-covered one, so a freshly-listed instrument cannot hide behind its
better-observed neighbours. The measurement names no fallback for a projection
carrying no nameable asset: with no asset set, nothing distinguishes a price from
any other positive number, so an unknown shape measures ZERO rather than
everything. Evidence-free frames — an empty price map, a `0` or negative stall
sentinel, an inherited or accessor price — pad nothing, and the ownness check
that decides so is itself prototype-independent.

```pseudo
if data_sufficiency_min_coverage is supplied and is not the number 0:  # absent / null / 0 is OFF
  # ARMED. Note the arming test is deliberately NOT "is a positive number": a
  # non-number ('', false, '0.5') arms the gate and fails it closed below, so a
  # malformed knob can never degrade to no gate at all.
  assert data_sufficiency_min_coverage is a number, finite, >= 0, and — when
         positive — does not quantize to 0 at the descriptor's 12 decimals
  descriptor = forecast.dataSufficiency               # own data properties only
  assert forecast.horizon is readable and a whole, non-negative tick count
  assert descriptor is readable and its counts are whole and non-negative
  assert descriptor.horizon == forecast.horizon
  assert descriptor.historyReturns <= max(0, descriptor.historyFrames - 1)
  recomputed = round12(descriptor.historyReturns / descriptor.horizon) if horizon > 0 else 0
  assert round12(recomputed) == round12(descriptor.coverageRatio)  # never trust the reported ratio
  # PROVENANCE BINDING: the descriptor is a hashed component of the projection
  # artifact, so recompute the artifact's projectionId and require the proposal
  # to cite it — a descriptor swapped onto a thinner or foreign forecast changes
  # the id and no longer matches. Fails closed when unrecomputable or uncited.
  assert projectionId(forecast) in proposal.cited_forecasts
  assert round12(recomputed) >= round12(data_sufficiency_min_coverage)
```

Two properties are load-bearing:

- **Off by default.** Absent, `null`, or the number `0` is OFF, and the invariant
  is not emitted at all, so every verdict predating the knob is unchanged.
- **Armed, it fails CLOSED.** An unusable threshold, an unreadable descriptor, an
  unreadable forecast horizon, counts that refute each other, a reported ratio its
  own counts refute, or a descriptor not bound to a cited forecast artifact all
  REJECT. Absence of evidence is not evidence of sufficiency, and a gate that
  rejects absent evidence must reject contradictory or unattested evidence at
  least as firmly — only one of them looks like a measurement.

There is **no unconditional pass**, and in particular no zero-horizon exemption.
A projection of 0 ticks recomputes to coverage 0 and clears no positive
requirement. It is true that a zero-tick projection cannot outrun its window, and
beside the point: the descriptor's horizon and the forecast's horizon are two
fields of the same self-reported object, so a zero corroborated only by its own
neighbour is an assertion, not evidence — and a hand-built `{ horizon: 0 }`
forecast would otherwise clear a demand for full coverage having simulated
nothing at all.

The gate recomputes coverage from the descriptor's primitive counts rather than
reading its reported ratio, the same discipline invariant 4 applies to the
proposal hash — and then goes one step further, **binding** the descriptor to
provenance. Because the descriptor is a hashed component of the projection
artifact (`projectionArtifact` folds it into the JSON that `projectionId`
hashes), the gate recomputes that id and requires the proposal to cite it. For a
**plain-data forecast** — the gate's real threat surface, since the
`audit_proposal` tool and the executor's fire-time re-audit both receive parsed
JSON, which carries no accessors, Proxies, or `toJSON` — a descriptor lifted onto
a thinner or foreign forecast, tampered at rest or in flight, changes the
recomputed id and no longer matches a cited one, so it fails closed. This closes
the "an internally consistent fabrication still clears it" gap that
self-consistency alone leaves open.

Two residuals remain, both disclosed rather than closed:

- **Self-consistency**, shared with invariant 4: a wholly self-consistent,
  self-cited artifact is measured, not disproven — exactly as a self-hashed
  proposal clears invariant 4's reproducibility check. The auditor holds no price
  window to recount the coverage from scratch; what the binding enforces is that
  the ratio it judges belongs to the forecast artifact the proposal committed to.
- **In-process split view**, out of the threat model: a hostile in-process object
  whose `getOwnPropertyDescriptor('dataSufficiency').value` (the gate's own-data
  snapshot) diverges from its `[[Get]]`/`toJSON` view (what `projectionId` hashes)
  — a Proxy with disagreeing `getOwnPropertyDescriptor`/`get` traps, or a `toJSON`
  — can present forged counts to the gate while presenting an honest artifact to
  the id recompute, binding forged coverage to an honest cited id. This needs a
  live JS Proxy or `toJSON` in the auditor's own process and cannot cross the JSON
  boundary the tool gate actually receives, so it is disclosed here rather than
  fixed: closing it would mean recomputing the id from the gate's own-data
  snapshot, which cannot be done without drifting from `projectionId` and
  fail-closing honest plain-data forecasts.

Callers therefore pass the whole projection through from the cited run and cite
its `projectionId`; they never synthesize a descriptor to satisfy the gate.

## Procedure

```pseudo
results = []
for invariant in invariants:
  try:
    invariant.verify(proposal)
    results.append({ name: invariant.name, status: 'pass' })
  except AssertionError as e:
    results.append({ name: invariant.name, status: 'fail', reason: str(e) })

verdict = 'approved' if all r.status == 'pass' else 'rejected'

emit_journal_result(
  kind='audit',
  proposal_hash=proposal.proposal_hash,
  verdict=verdict,
  invariant_results=results,
)
```

## Configuration

The configured floors and windows are canonical here, with optional per-dispatch overrides:

- `tail_risk_floor_pct`: default 80 (forecast's p05 must clear 80% of entry value).
- `staleness_window_ticks`: default 5.
- `per_step_max_pct_nav`: default 25.
- `per_day_max_pct_nav`: default 50.
- `per_instrument_concentration_cap_pct`: default 80.
- `data_sufficiency_min_coverage`: default 0 (OFF; invariant 7 is not emitted).
  When set to a positive number, the forecast's recomputed coverage ratio must
  clear it. A value the gate cannot evaluate (any non-number, a non-finite or
  negative number, or a positive one that rounds to zero at the descriptor's
  12-decimal resolution)
  ARMS the gate and fails it closed rather than degrading to no gate at all.

The maintainer adjusts these via a journal `message: liaison → *` entry; the auditor reads the most recent setting from the journal.

## Fire-time re-verification

The executor re-runs the same invariants at fire time, against the current chain state and oracle readings rather than the audit-time snapshot. Drift between audit and fire (balances changed, prices moved, oracles staled) surfaces as a fire-time abort. The executor's `result` entry names the invariant that broke.

## Notes

This skill is the safety story for live execution. Adding a new invariant here adds it to every future auditor verdict and every fire-time check. Removing or weakening one requires explicit maintainer authorization in a journal `message` entry; the auditor refuses to skip an invariant without one.
