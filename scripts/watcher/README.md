# scripts/watcher/

Per-feed activity watchers. Each `<feed>/watcher.sh` is a shell-only, read-only daemon with NO LLM context: it polls one feed on a fixed cadence and posts events to the journal job board. The events become job-board / inbox entries an LLM-context steward processes on its next cycle. The split keeps untrusted-or-large feed payloads out of any LLM context until a deterministic shell step has gated them.

Run a watcher under `scripts/systemd/finbot-watcher@<feed>.service` (the `%i` template specifier is the feed slug).

## Feed inventory

- `oracle/` — the price-oracle poll daemon. Read-only JSON-RPC reads against a pinned, trusted endpoint set; emits an opportunity-deviation event when a reading crosses the configured basis-point threshold. See `oracle/README.md`. The read protocol (ETag / If-Modified-Since caching, retry-on-5xx, threshold semantics) is owned by `skills/oracle-poll/SKILL.md`.

A `monitor/` feed (on-chain account-state watcher) is the next feed to land, following the same shape.

## Safety

Per `CLAUDE.md` § Monitoring safety constraint: only pinned, trusted endpoints are polled, reads are read-only, and adding an endpoint is a maintainer decision recorded in a journal `message` entry. A watcher never reads the wallet keystore.
