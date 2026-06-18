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

The maintainer adjusts these via a journal `message: liaison → *` entry; the auditor reads the most recent setting from the journal.

## Fire-time re-verification

The executor re-runs the same invariants at fire time, against the current chain state and oracle readings rather than the audit-time snapshot. Drift between audit and fire (balances changed, prices moved, oracles staled) surfaces as a fire-time abort. The executor's `result` entry names the invariant that broke.

## Notes

This skill is the safety story for live execution. Adding a new invariant here adds it to every future auditor verdict and every fire-time check. Removing or weakening one requires explicit maintainer authorization in a journal `message` entry; the auditor refuses to skip an invariant without one.
