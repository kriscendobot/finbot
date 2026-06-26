#!/bin/bash
# watcher.sh -- the oracle-watcher standing daemon (shell-only, read-only).
#
# Polls a pinned set of price oracles on a fixed cadence and posts an
# opportunity-deviation event to the journal job board when a reading crosses a
# configured threshold. This is the autonomous form of the oracle-watcher role
# (roles/oracle-watcher/AGENT.md § Two shapes); the one-shot LLM dispatch is for
# ad-hoc checks. This daemon has NO LLM context: it is shell only. The events it
# emits become job-board / inbox entries an LLM-context steward processes on its
# next cycle.
#
# Safety (CLAUDE.md § Monitoring safety constraint):
#   - READ-ONLY. Price-feed JSON-RPC reads only; this daemon never writes a chain.
#   - PINNED, TRUSTED ENDPOINTS ONLY. Endpoints come from a per-host config file
#     outside this repo (FINBOT_ORACLE_ENDPOINTS). Adding an endpoint is a
#     maintainer decision recorded in a journal `message` entry; this script
#     reads the configured set and polls nothing it was not given.
#   - The daemon never reads the wallet keystore.
#
# Invocation:
#
#   scripts/watcher/oracle/watcher.sh
#
# Environment overrides:
#
#   FINBOT_ROOT             default: script-location-relative grandparent's parent
#   FINBOT_JOURNAL_ROOT     default: $FINBOT_ROOT/../finbot-journal
#   FINBOT_HOST             default: $(hostname -s)
#   FINBOT_ORACLE_ENDPOINTS path to a config file: one "name<TAB>url" per line.
#                           Absent or empty -> the daemon idles (logs and sleeps);
#                           it never invents an endpoint to poll.
#   FINBOT_ORACLE_POLL_SECONDS  default: 30
#   FINBOT_ORACLE_THRESHOLD_BPS default: 30 (deviation that triggers an event)
#
# State (ETag / last-price cache) lives outside the journal, under
# $FINBOT_ROOT/.garden-oracle/ so it survives restarts without polluting the
# repo. See scripts/watcher/oracle/README.md for the feed inventory and the
# threshold semantics, and skills/oracle-poll/SKILL.md for the read protocol.

set -uo pipefail

FEED_SLUG=oracle

SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)
DEFAULT_FINBOT_ROOT=$(cd "$SCRIPT_PATH/../../.." && pwd)
FINBOT_ROOT=${FINBOT_ROOT:-$DEFAULT_FINBOT_ROOT}
FINBOT_JOURNAL_ROOT=${FINBOT_JOURNAL_ROOT:-$FINBOT_ROOT/../finbot-journal}
FINBOT_HOST=${FINBOT_HOST:-$(hostname -s)}
FINBOT_ORACLE_POLL_SECONDS=${FINBOT_ORACLE_POLL_SECONDS:-30}
FINBOT_ORACLE_THRESHOLD_BPS=${FINBOT_ORACLE_THRESHOLD_BPS:-30}
STATE_DIR="$FINBOT_ROOT/.garden-oracle"
LOG_TAIL="${FINBOT_ORACLE_LOG:-/tmp/finbot-oracle.log}"

mkdir -p "$STATE_DIR"

log() { echo "watcher[$FEED_SLUG]: $*" >&2; echo "$(date -u +%FT%TZ) $*" >> "$LOG_TAIL"; }

# Post one opportunity-deviation event to the job board. Shell-only producer:
# write the open-job file and commit+push it to origin/journal. The git push is
# the serialization point; a rejected push is retried on the next crossing.
post_crossing() {
  local name="$1" prev="$2" cur="$3" bps="$4"
  local sid utc rel
  sid=$(head -c3 /dev/urandom | xxd -p 2>/dev/null || echo "$RANDOM$RANDOM" | head -c6)
  utc=$(date -u +%Y%m%dT%H%M%SZ)
  rel="jobs/open/${utc}--${sid}--oracle-${name}.md"
  mkdir -p "$FINBOT_JOURNAL_ROOT/jobs/open"
  {
    echo "---"
    echo "job: $sid"
    echo "posted_by_role: oracle-watcher"
    echo "posted_by_host: $FINBOT_HOST"
    echo "posted_at: $(date -u +%FT%TZ)"
    echo "verb: orient-analyzer"
    echo "project: finbot"
    echo "eligible_roles:"
    echo "  - analyzer"
    echo "  - steward"
    echo "---"
    echo
    echo "# oracle crossing: $name"
    echo
    echo "deviation: ${bps}bps (threshold ${FINBOT_ORACLE_THRESHOLD_BPS}bps)"
    echo "reference: $prev"
    echo "current: $cur"
  } > "$FINBOT_JOURNAL_ROOT/$rel"
  if git -C "$FINBOT_JOURNAL_ROOT" add "$rel" \
     && git -C "$FINBOT_JOURNAL_ROOT" commit -q -m "oracle: crossing $name ${bps}bps" \
     && git -C "$FINBOT_JOURNAL_ROOT" push -q origin HEAD:journal; then
    log "NEW $rel"
  else
    log "post failed for $name (will retry on next crossing)"
    git -C "$FINBOT_JOURNAL_ROOT" reset -q --hard origin/journal 2>/dev/null || true
  fi
}

# One poll of one endpoint. Read-only; on a deviation past threshold, emit.
# The actual JSON-RPC read + bps math lands with the oracle-poll skill; until a
# trusted endpoint set is configured this is exercised only via the loop's
# idle path, which keeps the daemon safe-by-default (it polls nothing it was
# not explicitly given).
poll_endpoint() {
  local name="$1" url="$2"
  # Phase-1: the read protocol (ETag/If-Modified-Since, retry-on-5xx, bps math)
  # is owned by skills/oracle-poll/SKILL.md. With no live protocol wired yet,
  # log the intended read and return without emitting. This keeps the daemon
  # read-only and event-storm-free while the units and management scripts are
  # exercised end to end.
  log "would poll $name <$url> (oracle-poll protocol not yet wired)"
}

tick() {
  local cfg="${FINBOT_ORACLE_ENDPOINTS:-}"
  if [ -z "$cfg" ] || [ ! -s "$cfg" ]; then
    log "no endpoints configured (set FINBOT_ORACLE_ENDPOINTS); idling"
    return 0
  fi
  while IFS=$'\t' read -r name url; do
    [ -z "${name:-}" ] && continue
    case "$name" in \#*) continue;; esac
    poll_endpoint "$name" "$url" || log "poll error for $name (continuing)"
  done < "$cfg"
}

log "start: host=$FINBOT_HOST poll=${FINBOT_ORACLE_POLL_SECONDS}s threshold=${FINBOT_ORACLE_THRESHOLD_BPS}bps"
log "journal=$FINBOT_JOURNAL_ROOT state=$STATE_DIR"

# Tick-level resilience: one bad poll must never kill the daemon (the parent
# garden's standing rule after the bulletin crash-loop outage). Each tick is
# wrapped so a failure logs and the loop continues; systemd Restart=always plus
# StartLimitIntervalSec=0 on the unit is the backstop.
while true; do
  tick || log "tick error (continuing)"
  sleep "$FINBOT_ORACLE_POLL_SECONDS"
done
