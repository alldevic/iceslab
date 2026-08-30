#!/usr/bin/env bash
# singbox-build-selftest.sh
#
# `scripts/build-singbox.sh` compiles the ONE core this panel does not download,
# and everything it needs comes out of `packages/shared/src/core-binaries.ts` by
# line-matching TypeScript. That is a mirror-by-source, and mirrors by source
# fail in two silent ways: they read a comment instead of a value, or they match
# nothing and hand back an empty string that every later step accepts.
#
# Both happened here while this was being written. `file` matched the SOURCE
# ARCHIVE's name instead of the Go file to patch, because the parser takes the
# first key of that name in the block - the parse-only mode below is what
# printed it. So the parsing is checked here rather than trusted, against the
# real manifest and against manifests that are deliberately broken.
#
# What this does NOT do is build: no toolchain, no network, no docker. The build
# itself is exercised by `docker build --target singbox-builder`, and what it
# produces is checked by image-selftest.sh.
#
# Usage:
#   ./scripts/ops/singbox-build-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD="${ROOT}/scripts/build-singbox.sh"
MANIFEST="${ROOT}/packages/shared/src/core-binaries.ts"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[singbox-build-selftest]\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -f "$BUILD" ]] || { echo "no build script at $BUILD" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "no manifest at $MANIFEST" >&2; exit 1; }

# parse <manifest> -> the KEY=VALUE lines the script reads out of it.
parse() { SINGBOX_BUILD_PARSE_ONLY=1 sh "$BUILD" "$1" "$WORK/out" 2>&1; }

field() { parse "$1" | grep -m1 "^$2=" | cut -d= -f2-; }

# ───── the real manifest ─────
note "the real manifest"

OUT="$(parse "$MANIFEST")"
RC=$?
if [[ $RC -eq 0 ]]; then ok "parses"; else bad "parse failed rc=$RC: $OUT"; fi

check_field() {
    local key="$1" want="$2" got
    got="$(field "$MANIFEST" "$key")"
    if [[ "$got" == "$want" ]]; then ok "$key = $want"; else bad "$key = '$got', want '$want'"; fi
}
check_matches() {
    local key="$1" re="$2" got
    got="$(field "$MANIFEST" "$key")"
    if [[ "$got" =~ $re ]]; then ok "$key = $got"; else bad "$key = '$got', want /$re/"; fi
}

check_matches version '^[0-9]+\.[0-9]+\.[0-9]+$'
check_matches sha256  '^[0-9a-f]{64}$'
check_matches unpacksTo '^sing-box-[0-9.]+$'
check_field   packagePath './cmd/sing-box'
check_field   tagsFile 'release/DEFAULT_BUILD_TAGS_OTHERS'

# The tag is the entire reason this script exists. Without it the build produces
# the published binary again, which exits 1 on every config this panel writes.
if [[ "$(field "$MANIFEST" extraTags)" == *with_v2ray_api* ]]; then
    ok "extraTags carries with_v2ray_api"
else
    bad "extraTags does not carry with_v2ray_api: $(field "$MANIFEST" extraTags)"
fi

# The `file` vs `inFile` bug, kept as a case: the source block has its own
# `file`, and a parser that takes the first one patches the tarball's NAME
# instead of a Go source file. It read as a plausible value, which is how it got
# as far as a build.
check_field renameFile 'experimental/v2rayapi/stats.go'
check_field renameFrom 'v2ray.core.app.stats.command.StatsService'
check_field renameTo   'xray.app.stats.command.StatsService'

# The version and the directory the tarball unpacks into have to agree, or the
# build cds into a directory that is not there.
if [[ "$(field "$MANIFEST" unpacksTo)" == "sing-box-$(field "$MANIFEST" version)" ]]; then
    ok "unpacksTo tracks version"
else
    bad "unpacksTo does not track version"
fi

# ───── comments are not values ─────
note "comments are not values"

# The manifest's prose quotes other checksums and names other files. A parser
# that reads a comment reads a plausible wrong answer and says nothing.
POISONED="$WORK/poisoned.ts"
python3 - "$MANIFEST" "$POISONED" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
anchor = "      unpacksTo: 'sing-box-1.13.19',"
assert s.count(anchor) == 1, "anchor moved; update this case"
poison = (
    "      // an earlier pin was sha256: 'deadbeef" + "0" * 56 + "'\n"
    "      // and it unpacked to unpacksTo: 'sing-box-0.0.1'\n"
)
open(dst, "w").write(s.replace(anchor, poison + anchor))
PY

if [[ "$(field "$POISONED" unpacksTo)" == "sing-box-1.13.19" ]]; then
    ok "a commented-out unpacksTo does not win"
else
    bad "read the COMMENT: got '$(field "$POISONED" unpacksTo)'"
fi
if [[ "$(field "$POISONED" sha256)" != deadbeef* ]]; then
    ok "a commented-out sha256 does not win"
else
    bad "read the COMMENT: got '$(field "$POISONED" sha256)'"
fi

# ───── a malformed pin is refused, not passed on ─────
note "a malformed pin is refused"

refuses() {
    local name="$1" sed_expr="$2" out rc
    local broken="$WORK/broken.ts"
    sed "$sed_expr" "$MANIFEST" > "$broken"
    out="$(SINGBOX_BUILD_PARSE_ONLY=1 sh "$BUILD" "$broken" "$WORK/out" 2>&1)"
    rc=$?
    if [[ $rc -ne 0 ]]; then ok "$name -> refused"; else bad "$name -> ACCEPTED (rc=0): $out"; fi
}

# Each of these is an edit someone could plausibly make. An empty match is the
# dangerous one: it reads as "no value" and every later step is happy with it.
refuses "a truncated source sha256" \
        "s|sha256: 'abc2f4805b3fd088c18a5694b51fed6f0e1d06632fae98029d6bf7bd79a1b3a2'|sha256: 'abc2f480'|"
refuses "a version that is not x.y.z" \
        "s|    version: '1.13.19',|    version: 'latest',|"
refuses "extraTags without the tag this exists for" \
        "s|extraTags: \\['with_v2ray_api'\\]|extraTags: ['with_gvisor']|"
refuses "a tagsFile outside the release dir" \
        "s|tagsFile: 'release/DEFAULT_BUILD_TAGS_OTHERS'|tagsFile: '/etc/passwd'|"
refuses "a rename target that is not a Go file" \
        "s|inFile: 'experimental/v2rayapi/stats.go'|inFile: 'sing-box.tar.gz'|"
refuses "unpacksTo that does not match the version" \
        "s|unpacksTo: 'sing-box-1.13.19'|unpacksTo: 'sing-box-1.13.18'|"

# A manifest with no sing-box entry at all: the block matcher returns nothing,
# and nothing is exactly what a silent parser passes on.
NOSB="$WORK/nosb.ts"
grep -v "^  'sing-box': {" "$MANIFEST" > "$NOSB"
if ! SINGBOX_BUILD_PARSE_ONLY=1 sh "$BUILD" "$NOSB" "$WORK/out" >/dev/null 2>&1; then
    ok "a manifest with no sing-box entry -> refused"
else
    bad "a manifest with no sing-box entry -> ACCEPTED"
fi

# ───── the Dockerfile builds it the way the manifest says ─────
note "the image and the manifest agree"

DOCKERFILE="${ROOT}/apps/panel-backend/Dockerfile"
# The Go version lives in two places because a FROM cannot read a manifest.
# sing-box 1.13.19 does not compile under the node's 1.27.0 pin, so a drift here
# is a build that fails talking about a dependency instead of about a pin.
GO_IMG="$(grep -m1 '^ARG GO_IMAGE=golang:' "$DOCKERFILE" | sed 's/.*golang:\([0-9.]*\)-.*/\1/')"
GO_MANIFEST="$(sed -n "/^  'sing-box': {/,/^  },/p" "$MANIFEST" \
                 | sed 's;[[:space:]]*//.*;;' \
                 | grep -m1 "^ *goVersion: '" | sed "s/.*'\([^']*\)'.*/\1/")"
if [[ -n "$GO_IMG" && "$GO_IMG" == "$GO_MANIFEST" ]]; then
    ok "Go pin agrees: $GO_IMG"
else
    bad "Dockerfile builds with Go '$GO_IMG', manifest pins '$GO_MANIFEST'"
fi

if grep -q 'build-singbox.sh' "$DOCKERFILE"; then
    ok "the image calls the script rather than repeating it"
else
    bad "the Dockerfile does not call build-singbox.sh"
fi

# readelf is what proves the binary is static, and a missing readelf would make
# that check pass by not running. The stage has to install it.
if grep -qE '^RUN apk add .*binutils' "$DOCKERFILE"; then
    ok "the build stage installs binutils, so the static check can run"
else
    bad "no binutils in the singbox-builder stage; its readelf check would silently pass"
fi

printf '\n[singbox-build-selftest] %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
