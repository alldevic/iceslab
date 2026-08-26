#!/usr/bin/env bash
# cleanup-selftest.sh
#
# `cleanup.sh` is the one ops script that had no round-trip, and not out of
# laziness: it runs `docker image prune --all`, `docker builder prune --all`
# and `docker container prune`, all of which act on the WHOLE daemon. There is
# no flag that scopes them to a test stack, so running the real thing on a
# developer box reclaims that box's images — on the machine this was written on,
# 36 GB belonging to unrelated projects.
#
# What it promises, in its own header, is the part worth checking:
#
#     Does NOT touch:
#       - Named volumes (postgres_prod_data + redis_prod_data, the live DB).
#         `docker volume prune` is a foot-cannon, never run it blind on this
#         host.
#
# A promise about data is exactly the kind that cannot be verified by reading —
# `container prune` removing an anonymous volume, or a future `--volumes` added
# to one of the three, would read the same in the diff as it does today.
#
# So the whole thing runs against a docker daemon of its own, inside a
# docker:dind container. The prune commands then reach only that daemon, the
# host's images are untouched, and the state the script is supposed to preserve
# — a named volume with known bytes in it, and a running container — can be
# created and inspected for real.
#
# Needs: docker on the host, the `docker:27-dind` image, and permission to run
# a privileged container (dind requires it). Roughly 40s.
#
# Usage:
#   ./scripts/ops/cleanup-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[cleanup-selftest]\033[0m %s\n' "$1"; }

DIND="cleanup-selftest-dind-$$"
cleanup_container() { docker rm -f "$DIND" >/dev/null 2>&1 || true; }
trap cleanup_container EXIT

# ───── The isolated daemon ─────
#
# --privileged is what dind needs to run its own daemon. It is confined to this
# container, which is removed on exit, and nothing here mounts a host path: the
# point of the whole file is that the prunes cannot reach the host.
note "starting an isolated docker daemon"
if ! docker run -d --privileged --name "$DIND" \
        -e DOCKER_TLS_CERTDIR="" docker:27-dind >/dev/null 2>&1; then
    printf '\033[1;31mcannot start a dind container; this test needs docker and --privileged\033[0m\n' >&2
    exit 1
fi

# `docker exec ... docker` talks to the INNER daemon.
din() { docker exec "$DIND" "$@"; }

for _ in $(seq 1 40); do
    din docker info >/dev/null 2>&1 && break
    sleep 1
done
if ! din docker info >/dev/null 2>&1; then
    printf '\033[1;31mthe inner daemon never came up\033[0m\n' >&2
    docker logs "$DIND" 2>&1 | tail -20 >&2
    exit 1
fi

# The dind image is Alpine, whose `sh` is busybox ash, and cleanup.sh is a bash
# script (`${BASH_SOURCE[0]}`, `[[ ]]`, arrays). Running it under ash fails on
# the first substitution — which happened here, and read like the script being
# broken rather than the harness holding it wrong.
if ! din bash --version >/dev/null 2>&1; then
    din apk add --no-cache bash >/dev/null 2>&1
fi
if ! din bash --version >/dev/null 2>&1; then
    printf '\033[1;31mno bash inside the dind container and apk could not add one\033[0m\n' >&2
    exit 1
fi

# Refuse to go on if the inner daemon is not actually separate. Without this
# the whole file could be running the prunes against the host and every case
# would still pass, which is the one outcome this design exists to prevent.
host_images="$(docker images -q | sort | md5sum)"
inner_images="$(din docker images -q | sort | md5sum)"
if [[ "$host_images" == "$inner_images" ]]; then
    printf '\033[1;31mthe inner daemon shows the same images as the host; refusing to prune\033[0m\n' >&2
    exit 1
fi
note "inner daemon up and separate from the host"

# ───── The state cleanup.sh must preserve, and the state it must remove ─────
note "seeding the inner daemon"
din docker pull busybox:latest >/dev/null 2>&1

# A named volume with known bytes in it. This is the promise under test.
din docker volume create iceslab-selftest-data >/dev/null
din docker run --rm -v iceslab-selftest-data:/data busybox:latest \
    sh -c 'echo the-live-database > /data/keepme.txt' >/dev/null

# A RUNNING container, whose image must survive because something uses it.
din docker run -d --name iceslab-selftest-live busybox:latest sleep 600 >/dev/null

# A STOPPED container: step 3 is supposed to remove it.
din docker run --name iceslab-selftest-dead busybox:latest true >/dev/null 2>&1

# An unused image, which step 1 is supposed to reclaim. A SEPARATE image, not
# another tag on busybox: `image prune --all` works on images, not names, and
# busybox is held by the running container above — so a tag on it survives and
# reads as "step 1 did nothing". It did, while this was being written.
din docker pull hello-world:latest >/dev/null 2>&1

before_volumes="$(din docker volume ls -q | sort)"

# ───── Run the real script against the inner daemon ─────
#
# The script is copied in rather than bind-mounted: a bind mount would be a
# host path visible to a privileged container, which is what this file is
# trying not to do.
note "running cleanup.sh against it"
docker cp "${SCRIPT_DIR}/cleanup.sh" "$DIND:/cleanup.sh" >/dev/null
docker cp "${SCRIPT_DIR}/_lib.sh" "$DIND:/_lib.sh" >/dev/null
OUT="$(mktemp)"
din bash -c 'cd / && bash /cleanup.sh' >"$OUT" 2>&1
rc=$?

if [[ $rc -eq 0 ]]; then
    ok "cleanup.sh exits 0 on a daemon it can actually clean"
else
    bad "cleanup.sh exited $rc; output:
$(sed 's/^/      /' "$OUT")"
fi

# ───── The promise ─────
note "what it promised not to touch"
after_volumes="$(din docker volume ls -q | sort)"
if [[ "$after_volumes" == "$before_volumes" ]]; then
    ok "every named volume is still there"
else
    bad "the volume list changed:
      before: $(echo "$before_volumes" | tr '\n' ' ')
      after:  $(echo "$after_volumes" | tr '\n' ' ')"
fi

# Existing is not enough — the bytes are the point. A volume that survives as
# an empty one is the same outage as a volume that was removed.
content="$(din docker run --rm -v iceslab-selftest-data:/data busybox:latest cat /data/keepme.txt 2>/dev/null | tr -d '\r\n')"
if [[ "$content" == "the-live-database" ]]; then
    ok "and its contents are intact"
else
    bad "the volume survived but its data did not: got '${content}'"
fi

if din docker ps --format '{{.Names}}' | grep -q iceslab-selftest-live; then
    ok "a running container is left running"
else
    bad "the running container was removed"
fi

# ───── The work ─────
#
# Without these the file would pass against a cleanup.sh that does nothing at
# all, which is the same shape of empty test the rest of this repository keeps
# finding.
note "what it promised to remove"
if ! din docker ps -a --format '{{.Names}}' | grep -q iceslab-selftest-dead; then
    ok "the stopped container is gone"
else
    bad "the stopped container survived, so step 3 did nothing"
fi

if ! din docker images --format '{{.Repository}}' | grep -q hello-world; then
    ok "the unused image is reclaimed"
else
    bad "the unused image survived, so step 1 did nothing"
fi

# The image of the RUNNING container is the counter-case: `image prune --all`
# removes images without a container, and this one has one.
if din docker images --format '{{.Repository}}' | grep -q busybox; then
    ok "the image a running container needs is kept"
else
    bad "the running container's image was pruned out from under it"
fi

# ───── --dry ─────
note "--dry"
din docker pull hello-world:latest >/dev/null 2>&1
din docker run --name iceslab-selftest-dead2 busybox:latest true >/dev/null 2>&1
DRY_OUT="$(mktemp)"
din bash -c 'cd / && bash /cleanup.sh --dry' >"$DRY_OUT" 2>&1
if din docker images --format '{{.Repository}}' | grep -q hello-world &&
   din docker ps -a --format '{{.Names}}' | grep -q iceslab-selftest-dead2; then
    ok "--dry removes nothing"
else
    bad "--dry deleted something; output:
$(sed 's/^/      /' "$DRY_OUT")"
fi
if grep -q 'would run' "$DRY_OUT"; then
    ok "and says what it would have run"
else
    bad "--dry printed no plan:
$(sed 's/^/      /' "$DRY_OUT")"
fi

rc_arg="$(din bash -c 'cd / && bash /cleanup.sh --definitely-not-a-flag' >/dev/null 2>&1; echo $?)"
if [[ "$rc_arg" == "2" ]]; then
    ok "an unknown flag exits 2"
else
    bad "an unknown flag exited $rc_arg"
fi

rm -f "$OUT" "$DRY_OUT"

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
