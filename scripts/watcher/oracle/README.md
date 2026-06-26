# scripts/watcher/oracle/

The oracle-watcher standing daemon (`watcher.sh`): the autonomous form of the [oracle-watcher](../../../roles/oracle-watcher/AGENT.md) role. Shell-only, read-only, no LLM context.

## What it does

Polls a pinned set of price oracles every `FINBOT_ORACLE_POLL_SECONDS` (default 30). When a reading deviates from its reference by more than `FINBOT_ORACLE_THRESHOLD_BPS` (default 30) basis points, it posts one opportunity-deviation job to `journal/jobs/open/` (eligible roles: `analyzer`, `steward`) and logs a `NEW <path>` line to `/tmp/finbot-oracle.log`. The git push of the job file is the serialization point; a rejected push is retried on the next crossing.

## Configuration

Endpoints are NOT hard-coded. `FINBOT_ORACLE_ENDPOINTS` names a per-host file outside this repo, one `name<TAB>url` per line (lines beginning `#` are comments). Absent or empty, the daemon idles: it logs and sleeps, polling nothing it was not explicitly given. This is the safe default and the reason the daemon can run on any host before a trusted endpoint set is configured.

ETag / last-price cache state lives under `$FINBOT_ROOT/.garden-oracle/`, outside the journal, so it survives restarts without polluting the repo.

## Status

The cadence loop, event-posting, idle-on-no-endpoints path, and tick-level resilience are wired. The per-endpoint JSON-RPC read + basis-point math is owned by `skills/oracle-poll/SKILL.md` and lands with that skill; until then `poll_endpoint` logs the intended read without emitting, keeping the daemon read-only and event-storm-free while the units and management scripts are exercised end to end.

## Safety

Read-only, pinned/trusted endpoints only, never reads the wallet keystore. See `CLAUDE.md` § Monitoring safety constraint and the role brief's operating norms.
