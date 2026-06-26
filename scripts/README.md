# scripts/

Executable shell scripts for humans and systemd. The split is strict (mirrors the parent garden's convention): `roles/` and `skills/` hold no executables; `scripts/` holds no agent-only context fragments.

Layout:

- `scripts/driver/`: the standing driver. `persistent-driver.sh` runs `finbot --persistent --dry-run --compute`, so each tick computes a full in-process dry-run OODA cycle over the simulator (`runOodaCycle`) and journals real per-stage entries. Unit: `finbot-driver.service`.
- `scripts/watcher/<feed>/`: the per-feed activity watchers (shell-only, read-only, no LLM context). Landed: `oracle/` (price-oracle poll daemon). Next: `monitor/` (on-chain state poll daemon). Unit: `finbot-watcher@<feed>.service`. See `watcher/README.md`.
- `scripts/daemons/`: daemon-management wrappers and the LLM-context role loops. `agent-loop.sh` (the shared cadence wrapper) with `steward-loop.sh` / `journalist-loop.sh`, plus `install-units.sh`. See `daemons/README.md`.
- `scripts/systemd/`: systemd user units: `finbot-driver.service`, `finbot-watcher@.service` (templated per-feed), `finbot-steward.service`, `finbot-journalist.service`.

## What is wired

- **The dry-run compute driver** is the proven, testable path: `finbot --compute` runs the in-process OODA cycle each tick (`packages/pipeline/driver-compute.js` does the simulator + pipeline wiring; `packages/harness/loop.js`'s `compute` hook is where the driver tick calls it). Covered by `packages/harness/test/loop.test.js` and `packages/pipeline/test/driver-compute.test.js`.
- **The oracle-watcher daemon** polls a pinned endpoint set and posts deviation events; the per-endpoint read protocol lands with `skills/oracle-poll/SKILL.md` (the loop, event-posting, and idle-on-no-endpoints path are wired).
- **The steward and journalist loops** run one `claude -p` cycle per cadence; they idle cleanly when the `claude` CLI is absent so the units exercise end to end.

The pattern follows the parent garden's [`/home/kris/scripts/`](https://github.com/kriskowal/garden/tree/main/scripts) tree, adapted for finbot's role names and the per-host wallet-capability boundary. Every long-running unit carries `StartLimitIntervalSec=0` and tick-level resilience so one bad tick cannot crash-loop the service permanently (the parent garden's standing lesson).

## Safety

The driver is DRY-RUN ONLY (`bin/finbot` refuses `--compute --live`); watchers are read-only against pinned, trusted endpoints; the steward never originates a live executor dispatch. No script here reads the wallet keystore. Live on-chain action is a separate, explicitly-authorized executor dispatch per `designs/cap-attenuation.md`.
