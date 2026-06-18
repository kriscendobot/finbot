# scripts/

Executable shell scripts for humans and systemd. The split is strict (mirrors the parent garden's convention): `roles/` and `skills/` hold no executables; `scripts/` holds no agent-only context fragments.

Layout (to be grown as scripts land; bootstrap state is empty):

- `scripts/driver/`: the per-lane work driver. A finbot lane subscribes to a role-specific job board and runs claimed jobs to completion. Lanes can be `planner-1`, `analyzer-1`, etc.
- `scripts/watcher/<feed>/`: the per-feed activity watchers. Initial feeds: `oracle/` (price-oracle polling daemon), `monitor/` (on-chain state polling daemon).
- `scripts/daemons/`: daemon-management wrappers (start, stop, status, logs).
- `scripts/systemd/`: templated systemd user units (`finbot-watcher@<feed>.service`, `finbot-driver@<lane>.service`).

## Bootstrap state

This directory is a stub. The scripts will land when:

- The first oracle-watcher daemon is needed (probably the first thing).
- The first standing driver lane is needed (after a few one-shot dispatches have stabilized the dispatch shape).

The pattern to follow is the parent garden's [`/home/kris/scripts/`](https://github.com/kriskowal/garden/tree/main/scripts) tree, adapted for finbot's role names and the per-host wallet-capability boundary.
