#!/bin/bash
# agent-loop.sh -- run an LLM-context finbot role on a fixed cadence.
#
# The driving loop (scripts/driver/persistent-driver.sh) is a deterministic,
# no-LLM compute path. The steward and journalist are LLM-context roles: each
# cycle is one `claude -p` invocation that reads its role brief and acts. This
# script is the cadence wrapper both share; the per-role wrappers
# (steward-loop.sh, journalist-loop.sh) call it with their role name.
#
# Each cycle:
#   1. Build the dispatch prompt (the CLAUDE.md § Dispatch prompt template,
#      pointed at the live finbot root rather than a per-dispatch worktree, since
#      these are standing loops not one-shot dispatches).
#   2. Run `claude -p` with that prompt, bounded by a per-cycle timeout.
#   3. Sleep the cadence and repeat.
#
# Tick-level resilience: a failing cycle logs and the loop continues; it never
# crash-loops out (the parent garden's standing rule). systemd Restart=always +
# StartLimitIntervalSec=0 on the unit is the backstop.
#
# SAFETY: the steward holds bounded authority and may NOT originate live executor
# dispatches (roles/steward/AGENT.md § Posture). The journalist only writes the
# transcript. Neither loop is authorized for live on-chain action; that gate
# lives in the executor role and requires an explicit pre-staged authorization.
#
# Invocation:
#
#   scripts/daemons/agent-loop.sh <role>
#
# Environment overrides:
#
#   FINBOT_ROOT             default: script-location-relative grandparent's parent
#   FINBOT_JOURNAL_ROOT     default: $FINBOT_ROOT/../finbot-journal
#   FINBOT_<ROLE>_CADENCE_SECONDS   per-role cadence (default 300)
#   FINBOT_AGENT_CYCLE_TIMEOUT      per-cycle hard timeout (default 1200s)
#   FINBOT_CLAUDE_BIN       the claude CLI (default: claude). When absent the
#                           loop logs the prompt it would run and idles, so the
#                           unit and management scripts exercise end to end on a
#                           host without the CLI installed.

set -uo pipefail

ROLE="${1:-}"
if [ -z "$ROLE" ]; then
  echo "agent-loop: usage: agent-loop.sh <role>" >&2
  exit 2
fi

SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)
DEFAULT_FINBOT_ROOT=$(cd "$SCRIPT_PATH/../.." && pwd)
FINBOT_ROOT=${FINBOT_ROOT:-$DEFAULT_FINBOT_ROOT}
FINBOT_JOURNAL_ROOT=${FINBOT_JOURNAL_ROOT:-$FINBOT_ROOT/../finbot-journal}
FINBOT_CLAUDE_BIN=${FINBOT_CLAUDE_BIN:-claude}
CYCLE_TIMEOUT=${FINBOT_AGENT_CYCLE_TIMEOUT:-1200}

ROLE_UC=$(echo "$ROLE" | tr '[:lower:]-' '[:upper:]_')
cadence_var="FINBOT_${ROLE_UC}_CADENCE_SECONDS"
CADENCE=${!cadence_var:-300}

LOG_TAIL="${FINBOT_AGENT_LOG:-/tmp/finbot-${ROLE}.log}"
log() { echo "agent-loop[$ROLE]: $*" >&2; echo "$(date -u +%FT%TZ) $*" >> "$LOG_TAIL"; }

build_prompt() {
  cat <<EOF
You are the $ROLE, an autonomous standing loop in the finbot bot sandbox.
finbot root: $FINBOT_ROOT
journal root: $FINBOT_JOURNAL_ROOT

Read these in order, then run exactly one cycle and exit:
  1. $FINBOT_ROOT/roles/COMMON.md   (standing instructions)
  2. $FINBOT_ROOT/roles/$ROLE/AGENT.md   (your role)
  3. skills referenced by your role, only as you need them.

This is one cycle of a cadence loop (every ${CADENCE}s), not a one-shot dispatch:
do one pass of your role's per-cycle work, journal it, and exit. Do not loop
internally. SAFETY: you are in the bounded-authority sandbox. Never originate a
live executor dispatch or any irreversible on-chain action; the executor's live
gate requires an explicit pre-staged authorization you do not hold.
EOF
}

run_cycle() {
  local prompt
  prompt=$(build_prompt)
  if ! command -v "$FINBOT_CLAUDE_BIN" >/dev/null 2>&1; then
    log "claude CLI ('$FINBOT_CLAUDE_BIN') not found; would run cycle with prompt:"
    echo "$prompt" >&2
    return 0
  fi
  log "cycle start (timeout ${CYCLE_TIMEOUT}s)"
  if timeout "$CYCLE_TIMEOUT" "$FINBOT_CLAUDE_BIN" -p "$prompt" >>"$LOG_TAIL" 2>&1; then
    log "cycle ok"
  else
    log "cycle failed rc=$? (continuing)"
  fi
}

log "start: cadence=${CADENCE}s journal=$FINBOT_JOURNAL_ROOT claude=$FINBOT_CLAUDE_BIN"
while true; do
  run_cycle || log "cycle error (continuing)"
  sleep "$CADENCE"
done
