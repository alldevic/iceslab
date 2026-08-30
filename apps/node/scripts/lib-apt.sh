#!/usr/bin/env bash
# apt_get — the one way anything in this directory talks to apt.
#
# Both installers (scripts/install-iceslab.sh, scripts/install-iceslab-node.sh)
# already carry these options and explain at length why: a cloud image runs
# unattended-upgrades on first boot, that holds /var/lib/dpkg/lock-frontend, and
# a bare `apt-get install` does not wait for it — it exits 100 with
#
#   E: Could not get lock /var/lib/dpkg/lock-frontend.
#      It is held by process NNNN (unattended-upgr)
#
# The protocol bootstraps this directory holds are run as a fresh `bash <file>`
# from those installers, so a shell array does not reach them, and four of them
# called apt-get with no options at all. Measured 2026-08-28 on a Debian 13 KVM
# guest: bootstrap-amneziawg.sh hit exactly that lock and took the whole install
# down at step 4 of 8, with the agent already built and the one-shot bootstrap
# token already spent.
#
# `--force-confold`/`--force-confdef` keep an unattended run from stopping on a
# conffile prompt. Sourced, not copied: one decision, one place.
#
# DPkg::Lock::Timeout is NOT the whole answer, which is what the retry below is
# for. It covers dpkg's locks; it does not cover /var/lib/apt/lists/lock, the
# one `apt-get update` takes first. Measured 2026-08-30 on a Debian 13 guest
# with that lock held for 25 s:
#
#   apt-get -o DPkg::Lock::Timeout=300 update  ->  rc=100 in 0 s
#   E: Could not get lock /var/lib/apt/lists/lock. It is held by process NNNN
#
# It did not wait at all. Which leaves the boot-time case these options were
# added for - a cloud image running apt-daily/unattended-upgrades - still able
# to kill an install outright: it took the node installer down at step 1 of 8,
# after the one-shot bootstrap token had been spent. With the retry, the same
# race waits the lock out and returns 0.
#
# apt has no option for that lock, so waiting for it is a retry loop. Only a
# lock message is retried: every other failure is returned as it is, at once.

# apt_get <apt-get args...>
apt_get() {
  # The budget is defaulted HERE, not on a line beside the function: read from
  # an outer line it can be separated from, an unset value makes
  # `(( ... >= ))` true on the first pass and the retry silently becomes a
  # no-op. Measured exactly that way against a held lists lock.
  local out rc started=$SECONDS budget=${APT_LOCK_WAIT_SECS:-300}
  while :; do
    out=$(DEBIAN_FRONTEND=noninteractive apt-get \
      -o "DPkg::Lock::Timeout=300" \
      -o "Dpkg::Options::=--force-confold" \
      -o "Dpkg::Options::=--force-confdef" \
      "$@" 2>&1)
    # Taken straight off the assignment, NOT after an `if`: a false `if` with no
    # `else` leaves $? at 0, so reading it there returned success for every
    # failure that was not a lock. Caught by the selftest case that RUNS this
    # loop against a fake apt rather than grepping for it.
    rc=$?
    if (( rc == 0 )); then
      printf '%s\n' "$out"
      return 0
    fi
    if [[ "$out" != *"Could not get lock"* && "$out" != *"Unable to lock"* ]] ||
       (( SECONDS - started >= budget )); then
      printf '%s\n' "$out" >&2
      return "$rc"
    fi
    printf 'apt is locked by another process, waiting: %s\n' \
      "$(printf '%s' "$out" | grep -m1 -i 'lock' || true)" >&2
    sleep 5
  done
}
