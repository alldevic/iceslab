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

CONTAINER="${ZAPRET2_CONTAINER:-zapret2-proxy}"
TUNE_FILE="${ZAPRET2_TUNE_PATH:-/var/lib/iceslab-node/egress-tune.json}"
DOMAINS="${SELFTUNE_DOMAINS:-rutracker.org}"   # comma-separated
TOP="${SELFTUNE_TOP:-1}"
SEP='===REPORT-SEP==='

log() { printf '[selftune] %s\n' "$*"; }

# SELFTUNE_REPORT_FILE substitutes a captured report for a live scan, which is
# how this path was exercised on the s1 node without waiting for a real scan.
reports=""
if [ -n "${SELFTUNE_REPORT_FILE:-}" ]; then
  log "using fixture report ${SELFTUNE_REPORT_FILE} (no live scan)"
  reports="$(cat "$SELFTUNE_REPORT_FILE")"
else
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
