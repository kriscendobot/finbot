#!/bin/bash
# install-units.sh -- install / enable finbot's systemd user units.
#
# Mirrors the parent garden's scripts/jobs/install-units.sh shape, scoped to
# finbot's units. The templated units use systemd specifiers (%h = the bot
# user's home = the finbot root, %i = the watcher feed slug), so installation is
# a copy into ~/.config/systemd/user with no @GARDEN_ROOT@-style substitution
# needed.
#
# Usage:
#   scripts/daemons/install-units.sh install          # copy unit files
#   scripts/daemons/install-units.sh enable-services  # enable + start the set
#   scripts/daemons/install-units.sh status           # show unit states
#   scripts/daemons/install-units.sh disable          # stop + disable the set
#
# The enabled set:
#   finbot-driver.service               the dry-run OODA compute driver
#   finbot-watcher@oracle.service       the read-only oracle poll daemon
#   finbot-steward.service              the bounded-authority orchestrator loop
#   finbot-journalist.service           the transcript-consolidation loop
#
# Bring-up preconditions (one-time, like the parent garden):
#   - loginctl enable-linger "$USER"   so --user units run headless.

set -uo pipefail

SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)
FINBOT_ROOT=$(cd "$SCRIPT_PATH/../.." && pwd)
UNIT_SRC="$FINBOT_ROOT/scripts/systemd"
UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

SERVICES=(
  finbot-driver.service
  "finbot-watcher@oracle.service"
  finbot-steward.service
  finbot-journalist.service
)

TEMPLATES=(
  finbot-driver.service
  "finbot-watcher@.service"
  finbot-steward.service
  finbot-journalist.service
)

cmd_install() {
  mkdir -p "$UNIT_DST"
  for u in "${TEMPLATES[@]}"; do
    cp -v "$UNIT_SRC/$u" "$UNIT_DST/$u"
  done
  systemctl --user daemon-reload
  echo "installed ${#TEMPLATES[@]} unit file(s) into $UNIT_DST"
}

cmd_enable_services() {
  systemctl --user daemon-reload
  for s in "${SERVICES[@]}"; do
    systemctl --user enable --now "$s" && echo "enabled+started $s" || echo "FAILED $s"
  done
}

cmd_status() {
  for s in "${SERVICES[@]}"; do
    printf '%-36s ' "$s"
    systemctl --user is-active "$s" 2>/dev/null || true
  done
}

cmd_disable() {
  for s in "${SERVICES[@]}"; do
    systemctl --user disable --now "$s" 2>/dev/null && echo "disabled $s" || echo "skip $s"
  done
}

case "${1:-}" in
  install) cmd_install;;
  enable-services) cmd_enable_services;;
  status) cmd_status;;
  disable) cmd_disable;;
  *) echo "usage: $0 {install|enable-services|status|disable}" >&2; exit 2;;
esac
