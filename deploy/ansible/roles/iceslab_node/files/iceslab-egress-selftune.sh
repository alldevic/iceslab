#!/usr/bin/env bash
# F3 - node-side zapret2 self-tune, scan half.
#
# Runs blockcheckw (bundled in ss-zapret2) against domains known to be blocked
# from this node's uplink and drops the raw JSON reports where the node-agent
# reads them. The agent parses the reports, splices the winning TLS strategy
# into the zapret2 config the panel pushed, and reloads the container.
#
# This script deliberately does NOT edit the config or restart anything. An
# earlier version did, which made it and the panel two writers of one file:
# whichever ran last won, and an operator could not tell which strategy was
# actually running. Now the node contributes ONE line and the panel owns the
# rest, merged at the point the file is written (see internal/egress/zapret2).
#
# Deployed + timed by the U6 ansible role, off by default
# (iceslab_zapret2_selftune).
set -euo pipefail

TUNE_FILE="${ZAPRET2_TUNE_PATH:-/var/lib/iceslab-node/egress-tune.json}"
DOMAINS="${SELFTUNE_DOMAINS:-rutracker.org}"   # comma-separated
TOP="${SELFTUNE_TOP:-1}"
SEP='===REPORT-SEP==='

log() { printf '[selftune] %s\n' "$*"; }

# Which container blockcheckw lives in.
#
# This used to be `${ZAPRET2_CONTAINER:-zapret2-proxy}` and nothing ever set
# ZAPRET2_CONTAINER: the systemd unit passed ZAPRET2_DIR, which this script did
# not read, while the name it did read was never passed. So a stack whose
# container is not called `zapret2-proxy` scanned nothing on every tick — and
# before the emptiness guard below was fixed, erased the last usable report
# while doing it.
#
# Guessing a name is the wrong instrument twice over: the stack is an external
# repository that can rename its service, and a wrong name is indistinguishable
# from a container that is down. So ask the thing that can answer. An explicit
# ZAPRET2_CONTAINER wins; otherwise compose in ZAPRET2_DIR is asked what it
# actually brought up; the built-in name is the last resort. Whichever it was
# is said out loud, because "scan produced nothing" reads very differently
# depending on which of the three answered.
DEFAULT_CONTAINER=zapret2-proxy
CONTAINER=""
CONTAINER_SOURCE=""
resolve_container() {
  if [ -n "${ZAPRET2_CONTAINER:-}" ]; then
    CONTAINER="$ZAPRET2_CONTAINER"
    CONTAINER_SOURCE="ZAPRET2_CONTAINER"
    return
  fi
  if [ -n "${ZAPRET2_DIR:-}" ] && [ -d "$ZAPRET2_DIR" ]; then
    local id
    id="$(docker compose --project-directory "$ZAPRET2_DIR" ps -q 2>/dev/null | head -1)"
    if [ -n "$id" ]; then
      CONTAINER="$id"
      CONTAINER_SOURCE="compose in $ZAPRET2_DIR"
      return
    fi
  fi
  CONTAINER="$DEFAULT_CONTAINER"
  CONTAINER_SOURCE="built-in default (no ZAPRET2_CONTAINER, and compose named nothing)"
}

# SELFTUNE_REPORT_FILE substitutes a captured report for a live scan, which is
# how this path was exercised on the s1 node without waiting for a real scan.
reports=""
if [ -n "${SELFTUNE_REPORT_FILE:-}" ]; then
  log "using fixture report ${SELFTUNE_REPORT_FILE} (no live scan)"
  reports="$(cat "$SELFTUNE_REPORT_FILE")"
else
  # Resolved here rather than at the top: the fixture path below needs no
  # docker at all, and asking compose there would make a run that scans
  # nothing still depend on a working docker.
  resolve_container
  log "blockcheckw container: ${CONTAINER} (${CONTAINER_SOURCE})"
  for d in ${DOMAINS//,/ }; do
    log "scanning $d ..."
    out="$(docker exec "$CONTAINER" blockcheckw scan -d "$d" --auto --top "$TOP" \
            --no-conflict-cleanup --timeout 120 2>/dev/null || true)"
    # A domain that answered nothing contributes nothing. Appending its empty
    # slot anyway left the separator behind, and the emptiness check below then
    # looked at "\n===REPORT-SEP===\n" and called it content - so a container
    # that was down did not leave the last report in place, it replaced it with
    # a file of separators. The agent reads that as an unusable report, drops
    # the tune and quietly goes back to the untuned strategy.
    if [ -z "${out//[[:space:]]/}" ]; then
      log "  $d: no output from blockcheckw"
      continue
    fi
    reports+="$out"$'\n'"$SEP"$'\n'
  done
fi

if [ -z "${reports//[[:space:]]/}" ]; then
  log "scan produced nothing (container down?), leaving the last report in place"
  exit 0
fi

# Write through a temp file in the same directory: the agent polls this path,
# and a partially written report would read as a broken one.
mkdir -p "$(dirname "$TUNE_FILE")"
tmp="$(mktemp "${TUNE_FILE}.XXXXXX")"
printf '%s' "$reports" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$TUNE_FILE"
log "wrote scan reports to ${TUNE_FILE}; the agent applies them within a few minutes"
