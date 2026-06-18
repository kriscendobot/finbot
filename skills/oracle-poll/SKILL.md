---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: oracle-poll

The price-oracle read protocol. Rate-limit-aware, ETag-cached, debounced. Used by the [oracle-watcher](../../roles/oracle-watcher/AGENT.md) role both for one-shot dispatches and for the standing daemon. The shape mirrors the parent garden's `github-activity-poll` skill (polling discipline for external APIs).

## Purpose

Read a set of named oracle endpoints, return the current values, and emit threshold-crossing events when an oracle's value crosses a configured boundary since the previous read.

## Inputs

- **Oracle set.** A list of `(name, endpoint, query)` triples. For example:
  - `("usdc_pyth", "https://hermes.pyth.network/api/latest_price_feeds", "USDC/USD")`
  - `("eth_chainlink", "<rpc>", "AggregatorV3 latestRoundData on 0x...")`
- **Threshold configuration.** Per oracle:
  - `delta_bps`: emit a crossing event if the oracle's value changes by more than this many basis points since the last read.
  - `staleness_seconds`: emit a crossing event if the oracle has not been updated within this window.
  - `debounce_seconds`: do not emit more than one crossing event in this window for the same oracle.

## State

Per oracle, kept in the daemon's per-host state file (`/tmp/finbot-oracle-<host>.state`) or, for one-shot dispatches, in the journal under `journal/oracle-state/<oracle-name>.md`:

```yaml
oracle: usdc_pyth
last_value: 1.000123
last_read_at: <ISO>
last_etag: "abc..."
last_event_emitted_at: <ISO>
```

The daemon's state is short-lived (recreated on daemon restart with one missed tick at most). The journal's state file is durable; one-shot dispatches commit it back.

## Procedure

```sh
for oracle in "${ORACLES[@]}"; do
  # Conditional GET with the last ETag.
  RESPONSE=$(curl -fsSL --max-time 10 \
    -H "If-None-Match: $(read_etag "$oracle")" \
    -H "If-Modified-Since: $(read_last_read_at "$oracle")" \
    "$ENDPOINT_FOR_ORACLE")
  STATUS=$?
  if [ $STATUS -eq 0 ] && [ -z "$RESPONSE" ]; then
    # 304 Not Modified; oracle has not changed.
    continue
  fi

  VALUE=$(extract_value "$RESPONSE" "$QUERY")
  PREV=$(read_last_value "$oracle")
  DELTA_BPS=$(compute_delta_bps "$PREV" "$VALUE")

  if [ $DELTA_BPS -gt $THRESHOLD_BPS ]; then
    # Debounce check.
    LAST_EVENT=$(read_last_event_emitted_at "$oracle")
    if within_debounce_window "$LAST_EVENT" "$DEBOUNCE_SECONDS"; then
      continue
    fi
    # Emit a crossing event.
    emit_inbox_message "$oracle" "$PREV" "$VALUE" "$DELTA_BPS"
    write_last_event_emitted_at "$oracle" "$(date -u -Iseconds)"
  fi

  write_state "$oracle" "$VALUE" "$(date -u -Iseconds)" "$ETAG"
done
```

## Rate limits

Each oracle's endpoint has its own rate-limit budget. Use conservative cadences:

- Pyth: 1 read per oracle per 60 seconds (their public API tolerates more but we are not in a hurry).
- Chainlink (via RPC): 1 read per aggregator per 60 seconds.
- Spectrum / other GraphQL APIs: 1 read per query per 120 seconds.

The daemon's cadence is the outer loop; if N oracles are configured, the daemon iterates through them in order, sleeping between each to spread the load.

## Trusted feeds only

The oracle-watcher and the standing daemon both abide by `roles/COMMON.md` § Monitoring safety constraint: only pinned, trusted endpoints. The values returned by these endpoints are numbers, not free-text from an untrusted author, so the prompt-injection hazard the parent garden worries about (LLM context surfacing untrusted comment bodies) does not apply at this layer. But adding a new endpoint still requires explicit maintainer authorization in a journal `message` entry, because the financial decisions downstream of the data depend on its provenance.

## Output

The skill returns nothing directly; it side-effects state files and inbox messages. The one-shot dispatch wrapper (in the `oracle-watcher` role) reads the state and the emitted messages and writes a `result` entry summarizing the read.

## Notes

This is a stub. The actual `oracle-poll.sh` script (and its companion config schema for the per-oracle endpoint + query definitions) lands when the first liaison engagement needs to read a live oracle.
