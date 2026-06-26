#!/bin/bash
# steward-loop.sh -- the steward autonomous loop.
#
# The steward is finbot's bounded-authority orchestrator (roles/steward/AGENT.md).
# This is its standing form: one `claude -p` cycle on cadence, each pass draining
# the inbox, claiming job-board work, dispatching the appropriate OODA role, and
# journaling a tick. It never originates a live executor dispatch.
#
# Thin wrapper over scripts/daemons/agent-loop.sh; see that script for the
# environment overrides (cadence via FINBOT_STEWARD_CADENCE_SECONDS, default 300).
set -uo pipefail
SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)
exec "$SCRIPT_PATH/agent-loop.sh" steward
