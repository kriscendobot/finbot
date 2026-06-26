# scripts/daemons/

Daemon-management wrappers and the LLM-context role loops.

## The driving loop vs. the role loops

finbot runs two kinds of standing loop:

- **The driving loop** (`../driver/persistent-driver.sh`, unit `finbot-driver.service`) is a deterministic, no-LLM compute path: each tick runs the in-process dry-run OODA cycle (`runOodaCycle`) over the simulator and journals real per-stage entries. This is the proven, testable path.
- **The role loops** (`agent-loop.sh` and its wrappers, units `finbot-steward.service` / `finbot-journalist.service`) are LLM-context: each cycle is one `claude -p` invocation that reads the role brief and does one pass of that role's per-cycle work.

## Scripts

- `agent-loop.sh <role>` — the shared cadence wrapper for an LLM-context role. Builds the dispatch prompt (pointed at the live finbot root), runs `claude -p` under a per-cycle timeout, sleeps the cadence, repeats. Tick-resilient: a failing cycle logs and the loop continues. When the `claude` CLI is absent it logs the prompt it would run and idles, so the units exercise end to end on a host without the CLI.
- `steward-loop.sh` — thin wrapper: `agent-loop.sh steward`. The bounded-authority orchestrator (drain inbox, claim job-board work, dispatch the OODA role, journal a tick). Never originates a live executor dispatch.
- `journalist-loop.sh` — thin wrapper: `agent-loop.sh journalist`. Consolidates the period's entries into narrative digests.
- `install-units.sh {install|enable-services|status|disable}` — install / enable / inspect the finbot systemd user unit set.

## Bring-up

One-time, like the parent garden:

```sh
loginctl enable-linger "$USER"            # let --user units run headless
scripts/daemons/install-units.sh install
scripts/daemons/install-units.sh enable-services
scripts/daemons/install-units.sh status
```

## Safety

The driving loop is DRY-RUN ONLY (`bin/finbot` refuses `--compute --live`). The steward holds bounded authority and never originates a live executor dispatch; the journalist only writes the transcript. Live on-chain action is a separate, explicitly-authorized executor dispatch per `designs/cap-attenuation.md` and `roles/executor/AGENT.md`. No loop here reads the wallet keystore.
