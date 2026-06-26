#!/bin/bash
# persistent-driver.sh -- the standing dry-run OODA driver.
#
# Runs `finbot --persistent --dry-run --compute` so each tick computes a full
# in-process OODA cycle over the simulator (oracle-watcher -> analyzer ->
# forecaster -> planner -> auditor -> executor, all DRY-RUN) and journals real
# per-stage entries. This is the shell wrapper the systemd unit
# (scripts/systemd/finbot-driver.service) invokes; keeping the policy here means
# the unit file stays a thin Exec line.
#
# DRY-RUN ONLY. This driver never enables live mode, never reads a keystore, and
# never constructs a wallet capability. The `--compute` path is dry-run by
# construction (bin/finbot refuses `--compute --live`); live execution stays
# gated behind an explicit authorized executor dispatch per
# designs/cap-attenuation.md and roles/executor/AGENT.md.
#
# Invocation:
#
#   scripts/driver/persistent-driver.sh
#
# Environment overrides:
#
#   FINBOT_ROOT          default: script-location-relative grandparent
#   FINBOT_JOURNAL_ROOT  default: $FINBOT_ROOT/../finbot-journal
#   FINBOT_CADENCE_SECONDS  default: 60
#   FINBOT_DRIVER_JOB_BOARD when "1", also post jobs to the board each tick
#                           (default off: compute-only, so the board is not
#                           flooded with jobs no consumer will claim)
#   FINBOT_DRIVER_LOCAL_ONLY when "1", commit journal entries locally without
#                           pushing (a host with no journal remote configured)

set -uo pipefail

SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)
DEFAULT_FINBOT_ROOT=$(cd "$SCRIPT_PATH/../.." && pwd)
FINBOT_ROOT=${FINBOT_ROOT:-$DEFAULT_FINBOT_ROOT}
FINBOT_JOURNAL_ROOT=${FINBOT_JOURNAL_ROOT:-$FINBOT_ROOT/../finbot-journal}
FINBOT_CADENCE_SECONDS=${FINBOT_CADENCE_SECONDS:-60}

args=(--persistent --dry-run --compute
  --cadence "$FINBOT_CADENCE_SECONDS"
  --journal "$FINBOT_JOURNAL_ROOT")

if [ "${FINBOT_DRIVER_JOB_BOARD:-0}" != "1" ]; then
  args+=(--no-job-board)
fi
if [ "${FINBOT_DRIVER_LOCAL_ONLY:-0}" = "1" ]; then
  args+=(--local-only)
fi

echo "finbot-driver: FINBOT_ROOT=$FINBOT_ROOT" >&2
echo "finbot-driver: journal=$FINBOT_JOURNAL_ROOT cadence=${FINBOT_CADENCE_SECONDS}s" >&2
echo "finbot-driver: node bin/finbot ${args[*]}" >&2

cd "$FINBOT_ROOT" || exit 1
exec node bin/finbot "${args[@]}"
