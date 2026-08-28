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

# apt_get <apt-get args...>
apt_get() {
  DEBIAN_FRONTEND=noninteractive apt-get \
    -o "DPkg::Lock::Timeout=300" \
    -o "Dpkg::Options::=--force-confold" \
    -o "Dpkg::Options::=--force-confdef" \
    "$@"
}
