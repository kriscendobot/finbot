#!/bin/bash
# journalist-loop.sh -- the journalist autonomous loop.
#
# The journalist consolidates the journal's dispatch/tick/result sprawl into
# narrative digests (roles/journalist/AGENT.md). This is its standing form: one
# `claude -p` cycle on cadence, each pass writing a digest of the period's
# activity when the window warrants one. It adds no new analysis; it narrates
# what other roles produced.
#
# Thin wrapper over scripts/daemons/agent-loop.sh; cadence via
# FINBOT_JOURNALIST_CADENCE_SECONDS (default 300, but a longer cadence such as
# 3600 suits the journalist's consolidation cadence; set it on the unit).
set -uo pipefail
SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)
exec "$SCRIPT_PATH/agent-loop.sh" journalist
