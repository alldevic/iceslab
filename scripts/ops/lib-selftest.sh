#!/usr/bin/env bash
# lib-selftest.sh
#
# `_lib.sh` is the floor under every ops script - deploy, backup, restore,
# cleanup, logs - and nothing checked it. Two of its functions exist ONLY
# because of a live incident, and their comments say so:
#
#   * require_compose_root walks up to the project root because a deploy was
#     run from /opt/iceslab/scripts and died on a cryptic compose error
#     (2026-06-09);
#   * git_sync_to_ref replaced `git pull --ff-only` because that silently
#     no-ops on the tag-pinned detached HEAD the installer leaves, so operators
#     rebuilt stale code believing they had updated (2026-06-10, a panel stuck
#     rebuilding v0.1.2).
#
# A fix for an incident that nothing re-checks is a fix with a shelf life. The
# round-trip test next door found three defects in scripts that had been read
# and reviewed; this is the shared code underneath them.
#
# Needs git and bash. No docker, no network: the git cases use two local
# repositories, one acting as the other's origin.
#
# Usage:
#   ./scripts/ops/lib-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/_lib.sh"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[lib-selftest]\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Sourced here so the pure helpers can be called directly. LIB_PREFIX is what
# the log functions tag their output with.
LIB_PREFIX="selftest"
# shellcheck source=_lib.sh
source "$LIB"

# ───── fmt_duration ─────
note "fmt_duration"
check_duration() {
    local got
    got="$(fmt_duration "$1")"
    if [[ "$got" == "$2" ]]; then ok "${1}s -> $2"; else bad "${1}s -> $got, want $2"; fi
}
# It goes into every "done in X" line an operator reads to decide whether a
# deploy hung. Minutes must not be printed as 4500 seconds.
check_duration 0 "0s"
check_duration 59 "59s"
check_duration 60 "1m0s"
check_duration 3599 "59m59s"
check_duration 3600 "1h0m"
check_duration 7325 "2h2m"

# ───── retry ─────
note "retry"
# The real backoff sleeps 5s, then 10s. Shadowing `sleep` keeps this test in
# milliseconds while leaving the retry logic itself untouched - the point is
# how many times it calls, not how long it waits.
sleep() { :; }

attempts=0
always_fails() { attempts=$((attempts + 1)); return 7; }
succeeds_on_third() { attempts=$((attempts + 1)); (( attempts >= 3 )); }

attempts=0
if retry 3 true >/dev/null 2>&1 && [[ $attempts -eq 0 ]]; then
    ok "a command that works is run once"
else
    bad "retry called something unexpected on the happy path"
fi

attempts=0
retry 3 always_fails >/dev/null 2>&1
rc=$?
if [[ $attempts -eq 3 ]]; then ok "a failing command is tried the full count"; else bad "tried $attempts times, want 3"; fi
# The caller's `set -e` + ERR trap depend on the real exit code coming back,
# not a generic 1: a deploy step that swallowed it would report success.
if [[ $rc -eq 7 ]]; then ok "the last exit code is returned ($rc)"; else bad "returned $rc, want the command's 7"; fi

attempts=0
if retry 5 succeeds_on_third >/dev/null 2>&1 && [[ $attempts -eq 3 ]]; then
    ok "it stops at the first success"
else
    bad "kept going after success (attempts=$attempts)"
fi

unset -f sleep

# ───── require_compose_root ─────
note "require_compose_root"
# The incident: a deploy run from scripts/ died on a cryptic compose error.
# The fix walks UP from the lib's own location, so the test needs a copy of the
# lib inside a fake project tree.
ROOT="${WORK}/project"
mkdir -p "${ROOT}/scripts/ops" "${ROOT}/somewhere/deep"
cp "$LIB" "${ROOT}/scripts/ops/_lib.sh"
touch "${ROOT}/docker-compose.prod.yml" "${ROOT}/.env.production"

out="$(cd "${ROOT}/scripts/ops" && LIB_PREFIX=t bash -c 'source ./_lib.sh; require_compose_root; pwd' 2>/dev/null | tail -1)"
if [[ "$out" == "$ROOT" ]]; then
    ok "run from scripts/ops, it moves to the project root"
else
    bad "landed in [$out], want $ROOT"
fi

out="$(cd "${ROOT}/somewhere/deep" && LIB_PREFIX=t bash -c "source ${ROOT}/scripts/ops/_lib.sh; require_compose_root; pwd" 2>/dev/null | tail -1)"
if [[ "$out" == "$ROOT" ]]; then
    ok "run from anywhere under it, it still finds the root"
else
    bad "landed in [$out], want $ROOT"
fi

# Already there: it must not wander off looking for a different one.
out="$(cd "$ROOT" && LIB_PREFIX=t bash -c "source ${ROOT}/scripts/ops/_lib.sh; require_compose_root; pwd" 2>/dev/null | tail -1)"
if [[ "$out" == "$ROOT" ]]; then ok "already at the root, it stays"; else bad "moved to [$out]"; fi

# No project anywhere: bail with a message rather than let compose fail later
# against whatever happens to be in the current directory.
NOROOT="${WORK}/noroot/scripts/ops"
mkdir -p "$NOROOT"
cp "$LIB" "${NOROOT}/_lib.sh"
if (cd "$NOROOT" && LIB_PREFIX=t bash -c 'source ./_lib.sh; require_compose_root' >/dev/null 2>&1); then
    bad "accepted a directory with no compose file above it"
else
    ok "refuses when there is no project root above"
fi

# ───── git_short_sha ─────
note "git helpers"
NOGIT="${WORK}/nogit"
mkdir -p "$NOGIT"
out="$(cd "$NOGIT" && LIB_PREFIX=t bash -c "source ${LIB}; git_short_sha")"
if [[ "$out" == "no-git" ]]; then
    ok "git_short_sha answers no-git outside a repository"
else
    bad "answered [$out] outside a repository"
fi
if (cd "$NOGIT" && LIB_PREFIX=t bash -c "source ${LIB}; git_short_sha_or_die" >/dev/null 2>&1); then
    bad "git_short_sha_or_die accepted a non-repository"
else
    ok "git_short_sha_or_die refuses a non-repository"
fi

# ───── git_sync_to_ref ─────
note "git_sync_to_ref"
git_quiet() { git -c advice.detachedHead=false -c init.defaultBranch=main "$@" >/dev/null 2>&1; }

ORIGIN="${WORK}/origin"
mkdir -p "$ORIGIN"
(
    cd "$ORIGIN"
    git_quiet init
    git_quiet config user.email t@t; git_quiet config user.name t
    echo one > file.txt; git_quiet add .; git_quiet commit -m one
    git_quiet tag v1
    echo two > file.txt; git_quiet commit -am two
)
ORIGIN_HEAD="$(cd "$ORIGIN" && git rev-parse --short HEAD)"
ORIGIN_V1="$(cd "$ORIGIN" && git rev-parse --short v1)"

fresh_clone() {
    local dest="$1"
    rm -rf "$dest"
    git clone "$ORIGIN" "$dest" >/dev/null 2>&1
    (cd "$dest" && git_quiet config user.email t@t && git_quiet config user.name t)
}

run_sync() {
    # `source` + call in a subshell so an `exit 1` inside the lib does not take
    # this harness with it, and so each case starts from a clean environment.
    local dir="$1"; shift
    (cd "$dir" && env "$@" LIB_PREFIX=t bash -c "source ${LIB}; git_sync_to_ref; echo \"SYNC \$SYNC_TARGET \$SHA_BEFORE \$SHA_AFTER\"" 2>/dev/null | tail -1)
}

# The incident itself: the installer leaves a detached HEAD on a pinned tag, and
# `git pull --ff-only` there silently does nothing. Sync must land on main.
CLONE="${WORK}/clone"
fresh_clone "$CLONE"
(cd "$CLONE" && git_quiet checkout v1)
line="$(run_sync "$CLONE" ICESLAB_REF=)"
head_after="$(cd "$CLONE" && git rev-parse --short HEAD)"
branch_after="$(cd "$CLONE" && git symbolic-ref --short -q HEAD || echo DETACHED)"
if [[ "$head_after" == "$ORIGIN_HEAD" ]]; then
    ok "a detached tag-pinned checkout is brought up to the trunk"
else
    bad "HEAD is $head_after, want origin's $ORIGIN_HEAD ($line)"
fi
if [[ "$branch_after" == "main" ]]; then
    ok "and HEAD is re-attached to a branch, so it only happens once"
else
    bad "HEAD is still $branch_after"
fi

# Pinning a release must actually pin it.
fresh_clone "$CLONE"
run_sync "$CLONE" ICESLAB_REF=v1 >/dev/null
head_after="$(cd "$CLONE" && git rev-parse --short HEAD)"
if [[ "$head_after" == "$ORIGIN_V1" ]]; then ok "ICESLAB_REF=<tag> checks out that tag"; else bad "HEAD is $head_after, want $ORIGIN_V1"; fi

# A re-pointed tag makes a plain `--tags` fetch exit non-zero ("would clobber
# existing tag"), which under `set -e` aborts the deploy. The --force is what
# keeps re-deploys unblocked.
(
    cd "$ORIGIN"
    echo three > file.txt; git_quiet commit -am three
    git_quiet tag -f v1
)
ORIGIN_V1_NEW="$(cd "$ORIGIN" && git rev-parse --short v1)"
if [[ "$ORIGIN_V1_NEW" == "$ORIGIN_V1" ]]; then
    bad "the fixture did not actually re-point the tag"
else
    run_sync "$CLONE" ICESLAB_REF=v1 >/dev/null
    head_after="$(cd "$CLONE" && git rev-parse --short HEAD)"
    if [[ "$head_after" == "$ORIGIN_V1_NEW" ]]; then
        ok "a re-pointed tag is followed instead of aborting the deploy"
    else
        bad "HEAD is $head_after, want the re-pointed $ORIGIN_V1_NEW"
    fi
fi

# Local edits are somebody's work, or somebody's debugging. Overwriting them
# without being asked is the one thing a deploy must not do.
fresh_clone "$CLONE"
(cd "$CLONE" && git_quiet checkout main && echo "local edit" >> file.txt)
if (cd "$CLONE" && env ICESLAB_REF=main LIB_PREFIX=t bash -c "source ${LIB}; git_sync_to_ref" >/dev/null 2>&1); then
    bad "a dirty tree was reset without FORCE_RESET"
else
    ok "a dirty tree is refused"
fi
if grep -q "local edit" "${CLONE}/file.txt"; then
    ok "and the local edit survived the refusal"
else
    bad "the local edit was discarded by a refused sync"
fi

# ...but an operator who asks for it gets it.
if (cd "$CLONE" && env ICESLAB_REF=main FORCE_RESET=1 LIB_PREFIX=t bash -c "source ${LIB}; git_sync_to_ref" >/dev/null 2>&1); then
    if grep -q "local edit" "${CLONE}/file.txt"; then
        bad "FORCE_RESET=1 did not discard the local edit"
    else
        ok "FORCE_RESET=1 discards it as asked"
    fi
else
    bad "FORCE_RESET=1 was refused"
fi

# The caller logs these three; empty ones make a deploy log say "synced  ->  ".
fresh_clone "$CLONE"
(cd "$CLONE" && git_quiet checkout v1)
line="$(run_sync "$CLONE" ICESLAB_REF=main)"
read -r _ target before after <<<"$line"
if [[ -n "$target" && -n "$before" && -n "$after" ]]; then
    ok "SYNC_TARGET / SHA_BEFORE / SHA_AFTER are all set ($target $before -> $after)"
else
    bad "one of the reported globals is empty: [$line]"
fi

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
