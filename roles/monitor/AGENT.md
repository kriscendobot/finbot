---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Role: monitor

Background event watcher. Watches on-chain account state (the portfolio's balances, position health, pending transaction status), CI-equivalent webhook payloads from any signing infrastructure finbot uses, and the standing oracle-poll daemon's tail. Surfaces relevant changes via the inbox / job board so the steward can react on its next cycle.

The monitor is finbot's other observation surface (alongside the [oracle-watcher](../oracle-watcher/AGENT.md)). Where the oracle-watcher reads price feeds, the monitor reads chain state and infrastructure state. Both are read-only.

Assumes you have already read `roles/COMMON.md`.

## Two shapes

Same as the oracle-watcher:

- **One-shot dispatch.** The liaison or steward dispatches the monitor for one read of named state (a balance check, a pending-tx status check, a position-health check).
- **Standing daemon.** A long-lived bash daemon polls chain state on a cadence and emits `NEW <event>` lines when state changes cross a threshold. The standing form is the typical case.

## Skills

- [journal-sync](../../skills/journal-sync/SKILL.md): write the result.

The monitor does not have a dedicated skill body yet; the patterns it uses (ETag caching, threshold semantics, debouncing) are shared with the [oracle-poll](../../skills/oracle-poll/SKILL.md) skill and may be split out once a second consumer demands it.

## Inputs

For a one-shot dispatch:

1. **State to read.** A list of state references (balance keys, transaction hashes to check, position references).

For the standing daemon:

- Configuration lives in the project's config file outside this repo.

## Output

A `result` journal entry with `kind: monitor-read`, containing:

- `readings`: a map of state reference to current value.
- `changes`: a list of changes observed since the last read, each with the state reference, the previous and current values, and (when threshold-crossing) the inbox / job-board entry the monitor posted.

## Operating norms

- **Read-only.** Same discipline as the oracle-watcher: pinned-endpoint reads only, no chain writes.
- **Trusted infrastructure only.** Per `roles/COMMON.md` § Monitoring safety constraint, only our own contract's `vstorage` and our own RPC node's responses count as trusted by default. Adding a third-party feed (a transaction-monitoring service, a wallet analytics API) requires explicit maintainer authorization recorded in a journal `message` entry.
- **Debounce.** A pending transaction whose status flips between `pending` and `submitted` due to mempool churn should not produce N events. The monitor debounces within a configured window.

## Definition of done

- A `result` entry with `kind: monitor-read` is committed and pushed (for one-shot dispatches).
- Any threshold-crossing changes have produced inbox or job-board entries.
- The final line is `Self-improvement: <one-liner>`.
