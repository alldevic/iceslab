#!/bin/sh
# Runs before the image's 20-envsubst-on-templates.sh renders
# /etc/nginx/templates/default.conf.template.
#
# SUBSCRIPTION_PATH_PREFIX goes into a `location` line as it is, so a value
# the backend would refuse must not reach nginx either: the same rule as
# config.ts (`^/[a-zA-Z0-9_-]+$`). Plus the prefixes this server already
# routes elsewhere, where a second `location` would either fail nginx with
# "duplicate location" or quietly take the panel's own routes away.
set -eu

prefix="${SUBSCRIPTION_PATH_PREFIX:-}"

fail() {
  echo "iceslab-frontend: SUBSCRIPTION_PATH_PREFIX=\"$prefix\": $1" >&2
  exit 1
}

case "$prefix" in
  '') fail "empty; leave it unset for the default /sub" ;;
  /*) ;;
  *) fail "must start with /" ;;
esac
# Pattern matching, not `| grep`: plain sh, and nothing to race.
case "${prefix#/}" in
  '' | *[!a-zA-Z0-9_-]*) fail "use only [a-zA-Z0-9_-] after the /, the rule the backend applies" ;;
esac
case "$prefix" in
  /api|/admin|/health|/assets) fail "taken by the panel itself" ;;
esac

echo "iceslab-frontend: subscriptions proxied at ${prefix}/"
