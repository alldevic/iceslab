#!/bin/sh
# Runs before the image's 20-envsubst-on-templates.sh renders
# /etc/nginx/templates/default.conf.template.
#
# REMNAWAVE_COMPAT_PREFIX goes into a `location` line as it is, so a value the
# backend would refuse must not reach nginx either: the same rule as config.ts
# (one segment of [a-zA-Z0-9_-]; not a route the panel owns; not a honeypot trap
# prefix; not the subscription prefix, a second `location` there would fail nginx
# with "duplicate location").
#
# ⚠ One rule in two places, as for SUBSCRIPTION_PATH_PREFIX (15-subscription-prefix.sh):
# the pattern and the reserved list below are the same as
# REMNAWAVE_COMPAT_PREFIX in apps/panel-backend/src/config.ts, and they change
# as a pair.
set -eu

prefix="${REMNAWAVE_COMPAT_PREFIX:-}"

fail() {
  echo "iceslab-frontend: REMNAWAVE_COMPAT_PREFIX=\"$prefix\": $1" >&2
  exit 1
}

case "$prefix" in
  '') fail "empty; leave it unset for the default rw" ;;
  *[!a-zA-Z0-9_-]*) fail "one path segment of [a-zA-Z0-9_-], no slashes, the rule the backend applies" ;;
esac
lower=$(printf '%s' "$prefix" | tr 'A-Z' 'a-z')
case "$lower" in
  api | admin | health | assets) fail "taken by the panel itself" ;;
esac
# HONEYPOT_PREFIXES in the backend's lib/auth/honeypot-paths.ts: a shop there
# would be answered with a fake 404 and blacklisted.
case "/$lower" in
  /wp-admin* | /wp-login* | /wordpress* | /phpmyadmin* | /.git/*)
    fail "collides with a honeypot trap prefix" ;;
esac
sub="${SUBSCRIPTION_PATH_PREFIX:-/sub}"
sublower=$(printf '%s' "${sub#/}" | tr 'A-Z' 'a-z')
if [ "$lower" = "$sublower" ]; then
  fail "same path as SUBSCRIPTION_PATH_PREFIX ($sub); pick another segment"
fi

echo "iceslab-frontend: Remnawave facade proxied at /${prefix}/ (the backend answers 404 while the facade is off)"
