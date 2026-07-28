---
created: 2026-06-17
updated: 2026-06-17
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
now = current_iso_time()
for oracle_ref in proposal.cited_oracle_readings:
  reading = read_journal(oracle_ref)
  age_seconds = now - reading.read_at
  assert age_seconds <= configured_staleness_window_seconds
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
better-observed neighbours.

```pseudo
if data_sufficiency_min_coverage is a number > 0:      # absent / null / 0 is OFF
  descriptor = forecast.dataSufficiency               # own data properties only
  assert descriptor is readable and its counts are whole and non-negative
  assert descriptor.horizon == forecast.horizon        # and the forecast's own horizon is readable
  assert descriptor.historyReturns <= max(0, descriptor.historyFrames - 1)
  recomputed = descriptor.historyReturns / descriptor.horizon
  assert recomputed == descriptor.coverageRatio        # never read the reported ratio
  assert recomputed >= data_sufficiency_min_coverage
```

Two properties are load-bearing:

- **Off by default.** Absent, `null`, or the number `0` is OFF, and the invariant
  is not emitted at all, so every verdict predating the knob is unchanged.
- **Armed, it fails CLOSED.** An unusable threshold, an unreadable descriptor, an
  unreadable forecast horizon, counts that refute each other, or a reported ratio
  its own counts refute all REJECT. Absence of evidence is not evidence of
  sufficiency, and a gate that rejects absent evidence must reject contradictory
  evidence at least as firmly — only one of the two looks like a measurement.

The gate recomputes coverage from the descriptor's primitive counts rather than
reading its reported ratio, the same discipline invariant 4 applies to the
proposal hash. It is a weaker guarantee than invariant 4's, and knowing why
matters: invariant 4 recomputes from evidence the auditor independently holds,
while these counts remain self-reported by the artifact being gated. The gate
therefore bounds forgery (an inconsistent descriptor cannot approve itself), not
provenance (an internally consistent fabrication still clears it). Binding the
descriptor to an attested `projectionId` is how that gap closes.

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

The configured floors and windows live in the project README (canonical), with optional per-dispatch overrides:

- `tail_risk_floor_pct`: default 80 (forecast's p05 must clear 80% of entry value).
- `staleness_window_seconds`: default 300 (5 minutes).
- `per_step_max_pct_nav`: default 5.
- `per_day_max_pct_nav`: default 20.
- `per_instrument_concentration_cap_pct`: default 40.
- `data_sufficiency_min_coverage`: default 0 (OFF; invariant 7 is not emitted).
  When set to a positive number, the forecast's recomputed coverage ratio must
  clear it. A value the gate cannot evaluate (any non-number, a non-finite or
  negative number, or a positive one below the descriptor's 1e-12 resolution)
  ARMS the gate and fails it closed rather than degrading to no gate at all.

The maintainer adjusts these via a journal `message: liaison → *` entry; the auditor reads the most recent setting from the journal.

## Fire-time re-verification

The executor re-runs the same invariants at fire time, against the current chain state and oracle readings rather than the audit-time snapshot. Drift between audit and fire (balances changed, prices moved, oracles staled) surfaces as a fire-time abort. The executor's `result` entry names the invariant that broke.

## Notes

This skill is the safety story for live execution. Adding a new invariant here adds it to every future auditor verdict and every fire-time check. Removing or weakening one requires explicit maintainer authorization in a journal `message` entry; the auditor refuses to skip an invariant without one.
