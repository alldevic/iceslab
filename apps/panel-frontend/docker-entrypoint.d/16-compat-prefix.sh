#!/bin/sh
# Runs before the image's 20-envsubst-on-templates.sh renders
# /etc/nginx/templates/default.conf.template.
#
# REMNAWAVE_COMPAT_PREFIX goes into a `location` line as it is, so a value
# the backend would refuse must not reach nginx either: one segment of
# [a-zA-Z0-9_-], never `api` (the native API). The location is
# /<prefix>/api/, longer than any other prefix here, so it takes nothing
# else away.
#
# ⚠ One rule in two places, as for SUBSCRIPTION_PATH_PREFIX: this and
# REMNAWAVE_COMPAT_PREFIX in apps/panel-backend/src/config.ts change as a pair.
set -eu

prefix="${REMNAWAVE_COMPAT_PREFIX:-}"

fail() {
  echo "iceslab-frontend: REMNAWAVE_COMPAT_PREFIX=\"$prefix\": $1" >&2
  exit 1
}

case "$prefix" in
  '' | *[!a-zA-Z0-9_-]*) fail "one path segment of [a-zA-Z0-9_-], no slashes, the rule the backend applies" ;;
esac
case "$prefix" in
  api) fail "taken by the native API" ;;
esac

echo "iceslab-frontend: Remnawave-compat facade proxied at /${prefix}/api/"
