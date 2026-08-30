#!/usr/bin/env sh
# Build sing-box from the pinned source, WITH the build tag the published
# binaries lack.
#
# Why this exists at all. Upstream's release binaries are not built with
# `with_v2ray_api` - their own `sing-box version` prints the tag set and it is
# not in it - and sing-box does not ignore an `experimental.v2ray_api` block it
# cannot honour, it exits 1 before opening a port:
#
#   FATAL create service: create v2ray-server: v2ray api is not included in
#   this build, rebuild with -tags with_v2ray_api
#
# Every sing-box config the node-agent writes carries that block, because it is
# how per-user traffic is counted. So the published binary offers a choice
# between a sing-box engine with no accounting and one that does not run.
# Measured on a lab node 2026-08-30, on TUIC, AnyTLS, ShadowTLS and
# engine=singbox for xray, shadowsocks and hysteria alike.
#
# Called by the panel image build. Kept as a script rather than a RUN block so
# the manifest parsing below has one implementation and a test can run it
# against the real manifest (scripts/ops/singbox-build-selftest.sh) - the
# alternative was a second copy of a version and three checksums inside a
# Dockerfile, which is a second thing to forget on a bump.
#
# Usage: build-singbox.sh <manifest.ts> <out-dir> [arches]
#   arches default to "amd64 arm64"; armv7 is also understood.
#
# Output, per arch, in <out-dir>:
#   sing-box-<arch>          .tar.gz laid out exactly as upstream lays it out,
#                            `sing-box-<version>-linux-<arch>/sing-box`, so
#                            bootstrap-singbox.sh unpacks it unchanged
#   sing-box-<arch>.sha256   the sum of that file, which is what the panel then
#                            states to the node (there is no published sum to
#                            state, and the node refuses unvouched bytes)
#
# POSIX sh: this runs in golang:alpine, which has no bash.
set -eu

MANIFEST="${1:?usage: build-singbox.sh <manifest.ts> <out-dir> [arches]}"
OUT="${2:?usage: build-singbox.sh <manifest.ts> <out-dir> [arches]}"
ARCHES="${3:-amd64 arm64}"

fail() { echo "build-singbox: $*" >&2; exit 1; }

# ───── read the pin from the manifest ─────
#
# A mirror that reads source, so: comments are stripped FIRST. The prose around
# these fields names other fields and quotes other checksums, and a parser that
# reads a comment reads the wrong pin without saying so. Everything extracted is
# then checked for shape, because the failure mode of a silent empty match is a
# build that downloads nothing and succeeds.
block() {
  sed -n "/^  'sing-box': {/,/^  },/p" "$MANIFEST" | sed 's;[[:space:]]*//.*;;'
}
scalar() {
  block | grep -m1 "^ *$1: '" | sed "s/^ *$1: '\\([^']*\\)'.*/\\1/"
}

[ -f "$MANIFEST" ] || fail "no manifest at $MANIFEST"
[ -n "$(block)" ] || fail "no 'sing-box' entry in $MANIFEST"

VERSION=$(scalar version)
SRC_SHA=$(scalar sha256)
UNPACKS_TO=$(scalar unpacksTo)
PKG=$(scalar packagePath)
EXTRA_TAGS=$(block | grep -m1 '^ *extraTags: ' | grep -o "'[^']*'" | tr -d "'" | paste -sd, -)
TAGS_FILE=$(scalar tagsFile)
RENAME_FILE=$(scalar inFile)
RENAME_FROM=$(scalar from)
RENAME_TO=$(scalar to)

echo "$VERSION"    | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'  || fail "version '$VERSION' is not x.y.z"
echo "$SRC_SHA"    | grep -qE '^[0-9a-f]{64}$'            || fail "source sha256 '$SRC_SHA' is not 64 hex"
echo "$UNPACKS_TO" | grep -qE '^sing-box-[0-9.]+$'        || fail "unpacksTo '$UNPACKS_TO' looks wrong"
echo "$PKG"        | grep -qE '^\./'                      || fail "packagePath '$PKG' is not a relative package"
echo "$EXTRA_TAGS" | grep -q 'with_v2ray_api'             || fail "extraTags '$EXTRA_TAGS' lacks with_v2ray_api, which is the reason this script exists"
echo "$TAGS_FILE"  | grep -qE '^release/'                 || fail "tagsFile '$TAGS_FILE' is not a path inside the tarball"
echo "$RENAME_FILE" | grep -qE '^[a-z].*\.go$' \
  || fail "renameStatsService.inFile '$RENAME_FILE' is not a Go source path inside the tarball"
[ -n "$RENAME_FROM" ] || fail "renameStatsService.from is empty"
[ -n "$RENAME_TO" ]   || fail "renameStatsService.to is empty"
[ "$UNPACKS_TO" = "sing-box-$VERSION" ] || fail "unpacksTo '$UNPACKS_TO' does not match version '$VERSION'"

# Parse-only mode, for the self-test: say what was read and stop before the
# network. Lets the parsing be checked against the manifest without a toolchain.
if [ "${SINGBOX_BUILD_PARSE_ONLY:-}" = "1" ]; then
  echo "version=$VERSION"
  echo "sha256=$SRC_SHA"
  echo "unpacksTo=$UNPACKS_TO"
  echo "packagePath=$PKG"
  echo "tagsFile=$TAGS_FILE"
  echo "extraTags=$EXTRA_TAGS"
  echo "renameFile=$RENAME_FILE"
  echo "renameFrom=$RENAME_FROM"
  echo "renameTo=$RENAME_TO"
  exit 0
fi

# ───── source ─────
WORK="${SINGBOX_BUILD_WORK:-$(mktemp -d)}"
mkdir -p "$WORK" "$OUT"
URL="https://github.com/SagerNet/sing-box/archive/refs/tags/v${VERSION}.tar.gz"
if [ ! -f "$WORK/src.tar.gz" ]; then
  echo "sing-box $VERSION: fetching source <- $URL"
  curl -fsSL "$URL" -o "$WORK/src.tar.gz.part" || fail "source download failed: $URL"
  mv "$WORK/src.tar.gz.part" "$WORK/src.tar.gz"
fi
echo "${SRC_SHA}  $WORK/src.tar.gz" | sha256sum -c - >/dev/null \
  || fail "sha256 mismatch on the sing-box SOURCE: upstream moved or the pin is stale"

rm -rf "$WORK/$UNPACKS_TO"
tar xzf "$WORK/src.tar.gz" -C "$WORK"
cd "$WORK/$UNPACKS_TO"

# The base tag set comes from the tarball, so a version bump cannot leave a
# stale copy of it behind here. Upstream owns which features its release has;
# this owns the one addition that is ours.
[ -f "$TAGS_FILE" ] || fail "the source carries no $TAGS_FILE; upstream reorganised its release files"

# ───── the one line of upstream source this build rewrites ─────
#
# sing-box registers its StatsService under v2ray's gRPC service name and xray
# answers to its own; gRPC dispatches on that string, so the agent's stats
# client (the xray binary - sing-box ships no stats CLI) gets `Unimplemented`
# against a perfectly healthy API. The manifest's renameStatsService carries the
# full reasoning.
#
# Verified rather than trusted: a sed that matched nothing would leave the
# original failure in place and the build would say it succeeded.
[ -f "$RENAME_FILE" ] || fail "the source carries no $RENAME_FILE; upstream moved the v2ray stats service"
before=$(grep -c "$RENAME_FROM" "$RENAME_FILE" || true)
[ "$before" = "1" ] || fail "expected exactly one '$RENAME_FROM' in $RENAME_FILE, found $before"
sed -i "s|$RENAME_FROM|$RENAME_TO|" "$RENAME_FILE"
after=$(grep -c "$RENAME_TO" "$RENAME_FILE" || true)
[ "$after" = "1" ] || fail "the stats-service rename did not apply to $RENAME_FILE"
if grep -q "$RENAME_FROM" "$RENAME_FILE"; then
  fail "the old stats service name survives in $RENAME_FILE"
fi
echo "  stats service renamed: $RENAME_FROM -> $RENAME_TO"
TAGS="$(cat "$TAGS_FILE"),${EXTRA_TAGS}"
LDF="$(cat release/LDFLAGS)"
echo "  tags: $TAGS"

for arch in $ARCHES; do
  case "$arch" in
    amd64) GOARCH=amd64; GOARM= ;;
    arm64) GOARCH=arm64; GOARM= ;;
    armv7) GOARCH=arm;   GOARM=7 ;;
    *) fail "unknown architecture '$arch'" ;;
  esac

  echo "  building $arch"
  # GOTOOLCHAIN=local: without it a go.mod asking for a newer toolchain makes Go
  # fetch one, and the toolchain that was pinned would have decided nothing -
  # the same hole lib-go.sh closed on the node side.
  #
  # CGO_ENABLED=0 gives a static binary, which is load-bearing: the panel runs
  # on alpine and the nodes run Debian, so ONE artefact has to execute on both.
  # It only stays static because the tag set omits with_naive_outbound - see the
  # manifest; with it, the build needs either CGO or purego, and purego reaches
  # libdl dynamically, which puts an ELF interpreter back in the binary.
  GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" GOARM="$GOARM" \
    go build -trimpath \
      -ldflags "-X 'github.com/sagernet/sing-box/constant.Version=${VERSION}' ${LDF} -s -w -buildid=" \
      -tags "$TAGS" -o "$WORK/sing-box" "$PKG"

  # Refuse to ship a binary without the tag this whole script exists for. Only
  # a natively-built one can be asked; a cross-built one came off the same tag
  # list in the same command.
  if [ "$arch" = "$(go env GOHOSTARCH)" ] || { [ "$arch" = "armv7" ] && [ "$(go env GOHOSTARCH)" = "arm" ]; }; then
    "$WORK/sing-box" version | grep -q 'with_v2ray_api' \
      || fail "the binary just built does not carry with_v2ray_api; it would refuse to start on this panel's configs"
  fi

  # Asked of the ARTEFACT, not of the tag list. A dynamic binary here runs on
  # whichever libc built it and exits 127 on the other, and this one file has to
  # run on the alpine panel and on Debian nodes both. The old `-musl` pin existed
  # for exactly this and was measured the same way.
  #
  # Written as an `if` condition rather than `... | grep -q && fail`: that form
  # is the last command of its block, so under `set -e` the NO-INTERP case (grep
  # exits 1) would end the script on success.
  if readelf -l "$WORK/sing-box" 2>/dev/null | grep -q 'INTERP'; then
    fail "the $arch binary is dynamically linked (has an ELF interpreter); it would not run on both alpine and Debian"
  fi

  # Packaged the way upstream packages it, so the node unpacks it unchanged.
  stage="$WORK/pkg/sing-box-${VERSION}-linux-${arch}"
  rm -rf "$WORK/pkg"; mkdir -p "$stage"
  mv "$WORK/sing-box" "$stage/sing-box"
  chmod 0755 "$stage/sing-box"
  tar -C "$WORK/pkg" --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' \
    -czf "$OUT/sing-box-${arch}" "sing-box-${VERSION}-linux-${arch}"
  rm -rf "$WORK/pkg"

  sha256sum "$OUT/sing-box-${arch}" | awk '{print $1}' > "$OUT/sing-box-${arch}.sha256"
  echo "    ok sing-box-${arch} ($(wc -c < "$OUT/sing-box-${arch}") bytes, sha256 $(cut -c1-12 < "$OUT/sing-box-${arch}.sha256")…)"
done
