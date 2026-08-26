#!/usr/bin/env bash
# installer-selftest.sh
#
# The two installers (`install-iceslab.sh`, `install-iceslab-node.sh`) are the
# largest unexercised layer of this repo: 2415 lines that run as root on a fresh
# box and that no test has ever read. They deliberately source nothing — they
# are curl-piped and must work without the rest of `scripts/` — so `_lib.sh`'s
# own 24 checks do not touch them.
#
# The one that matters most is `pinned_fetch`. Every other guard found in this
# layer cost a deploy or a report; this one decides whether the xray/hysteria
# installer that is about to run as root on a node is the one we pinned. Its
# failure mode is somebody else's code on the node.
#
# What is asked of it here, and why each case is the observable one:
#
#   * a sha that does not match must leave NO FILE and a non-zero status. A
#     half-refusal (fail, but leave the download) is the next run finding the
#     file already there.
#   * a sha that matches must leave the file and SAY it verified.
#   * no sha at all must say it did not verify. Silence there reads to the
#     operator exactly like a checked pin.
#   * `--proto =https` and `--max-redirs 0` are guards too — http downgrade and
#     MITM-via-302 — and the only place they are observable is the argv curl
#     was given.
#
# The function is not copied here: its real text is cut out of the installer
# (`sed -n '/^pinned_fetch()/,/^}/p'`) and sourced, together with the real
# `log`/`warn`/`fail`, so `fail`'s exit 1 is the real one. `curl` is a stub on
# PATH. Same instrument as deploy-selftest.sh (stub `docker`) and
# logs-selftest.sh (stubs `docker`/`systemctl`/`journalctl`).
#
# The harness needs its own control: "the file is gone" is also true of a
# harness that never downloaded anything, so the first case proves the stub
# writes and the last-resort assertions read a real write.
#
# Needs bash, coreutils. No docker, no network, no systemd. Nothing here runs
# the installer's executable body, and in particular never `do_uninstall`,
# which stops units and removes /etc/xray on whatever host it is on.
#
# Usage:
#   ./scripts/ops/installer-selftest.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
NODE_INSTALLER="${REPO_ROOT}/scripts/install-iceslab-node.sh"
PANEL_INSTALLER="${REPO_ROOT}/scripts/install-iceslab.sh"

PASS=0
FAIL=0
ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[1;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '\033[1;36m[installer-selftest]\033[0m %s\n' "$1"; }

for f in "$NODE_INSTALLER" "$PANEL_INSTALLER"; do
    [[ -r "$f" ]] || { printf 'installer not readable: %s\n' "$f" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ───── The real text, cut out ─────
#
# Cutting rather than copying is the whole point: a copy would keep passing
# after the installer changed under it. If a cut comes back empty the function
# was renamed, and every case built on it would pass vacuously — so each
# extraction is checked for the thing it is supposed to contain.
FUNCS="${WORK}/funcs.sh"
{
    # log/warn/fail are one-liners; grabbing them by shape rather than by line
    # number survives edits above them.
    grep -E '^(log|warn|fail)\(\) +\{.*\}$' "$NODE_INSTALLER"
    sed -n '/^pinned_fetch()/,/^}/p' "$NODE_INSTALLER"
} > "$FUNCS"

if grep -q '^pinned_fetch()' "$FUNCS" && grep -q 'sha256sum' "$FUNCS"; then
    ok "pinned_fetch's real body was extracted from the installer"
else
    bad "could not cut pinned_fetch out of ${NODE_INSTALLER}; every case below would be vacuous"
    printf '\033[1;31maborting\033[0m\n'
    exit 1
fi
if grep -q '^fail() .*exit 1' "$FUNCS"; then
    ok "and the real fail(), the one that stops the install"
else
    bad "fail() was not extracted or no longer exits; a refusal would not be observable"
fi

BIN="${WORK}/bin"
mkdir -p "$BIN"

# The curl stub answers the two questions the real one answers — did it write a
# file, and with what — and records the argv, which is the only place the
# transport guards (--proto/--max-redirs) can be observed. It refuses to invent
# a download: with FAKE_CURL_RC set it writes nothing, the way a `-f` curl
# leaves nothing behind on a 404.
cat > "${BIN}/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_CURL_LOG"
out=""; prev=""
for a in "$@"; do
    [[ "$prev" == "-o" ]] && out="$a"
    prev="$a"
done
if [[ "${FAKE_CURL_RC:-0}" != "0" ]]; then
    echo "curl: (${FAKE_CURL_RC}) stub was told to fail" >&2
    exit "${FAKE_CURL_RC}"
fi
[[ -n "$out" ]] || { echo "curl stub: no -o target in argv" >&2; exit 2; }
printf '%s' "${FAKE_CURL_BODY:-}" > "$out"
printf 'WROTE %s bytes -> %s\n' "$(printf '%s' "${FAKE_CURL_BODY:-}" | wc -c)" "$out" >> "$FAKE_CURL_LOG"
exit 0
STUB
chmod +x "${BIN}/curl"

URL="https://raw.githubusercontent.com/XTLS/Xray-install/deadbeef/install-release.sh"
BODY='#!/bin/sh
echo "this is the upstream installer"'
GOOD_SHA="$(printf '%s' "$BODY" | sha256sum | awk '{print $1}')"
WRONG_SHA="$(printf 'a different payload entirely' | sha256sum | awk '{print $1}')"

OUT="${WORK}/out.txt"
CURL_LOG="${WORK}/curl.log"
PAYLOAD=""
CURL_RC=0
RC=0

# Mirrors the call sites: they mktemp the destination first, then hand it over.
# Doing the same here is what makes "the file is gone" a statement about
# pinned_fetch and not about a path that never existed.
#
# The status and the destination come back in globals rather than on stdout,
# and that is not a style choice. Written as `rc="$(run_pinned_fetch ...)"`
# this runs in a command substitution — a subshell — so the fresh $PAYLOAD
# never reached the caller, every `[[ ! -e "$PAYLOAD" ]]` asked about the empty
# string, and "the rejected download is removed" passed while proving nothing.
# The control two cases below is what caught it.
run_pinned_fetch() {
    local expect="${1-}"
    : > "$CURL_LOG"
    PAYLOAD="$(mktemp "${WORK}/payload.XXXXXX")"
    (
        set -euo pipefail
        export PATH="${BIN}:${PATH}"
        export FAKE_CURL_LOG="$CURL_LOG" FAKE_CURL_BODY="$BODY" FAKE_CURL_RC="$CURL_RC"
        # shellcheck source=/dev/null
        source "$FUNCS"
        pinned_fetch "$URL" "$PAYLOAD" "$expect"
    ) >"$OUT" 2>&1
    RC=$?
}

# ───── The harness's own control ─────
note "the harness itself"
run_pinned_fetch "$GOOD_SHA"
if [[ "$RC" == "0" ]]; then
    ok "a matching sha exits 0"
else
    bad "the happy path exited $RC:
$(sed 's/^/      /' "$OUT")"
fi
if [[ -f "$PAYLOAD" ]] && [[ "$(cat "$PAYLOAD")" == "$BODY" ]]; then
    ok "and the stub really downloaded: the payload is on disk, byte-for-byte"
else
    bad "nothing was written; 'the file is gone' below would be true of an empty harness"
fi

# ───── A sha that does not match ─────
note "sha256 mismatch"
run_pinned_fetch "$WRONG_SHA"
if [[ "$RC" != "0" ]]; then
    ok "a mismatched sha exits non-zero ($RC)"
else
    bad "a tampered download was accepted"
fi
if grep -q 'WROTE ' "$CURL_LOG"; then
    ok "and curl had in fact written the file first, so its absence means removal"
else
    bad "curl never wrote anything this run; the next check proves nothing"
fi
if [[ ! -e "$PAYLOAD" ]]; then
    ok "the rejected download is REMOVED, not left for the next run to find"
else
    bad "the rejected file is still at $PAYLOAD ($(wc -c <"$PAYLOAD") bytes): a rerun would find it in place"
fi
if grep -q "expected $WRONG_SHA" "$OUT" && grep -q "got $GOOD_SHA" "$OUT"; then
    ok "and both sums are named, which is what separates 'tampered' from 'bump the pin'"
else
    bad "the refusal did not name both sums:
$(sed 's/^/      /' "$OUT")"
fi

# ───── A sha that matches ─────
note "sha256 match"
run_pinned_fetch "$GOOD_SHA"
if grep -q 'sha256 verified' "$OUT"; then
    ok "a verified download says so"
else
    bad "a verified download was silent about it:
$(sed 's/^/      /' "$OUT")"
fi
if [[ -f "$PAYLOAD" ]]; then
    ok "and the file it verified is still there to run"
else
    bad "the verified payload was removed"
fi

# ───── No sha at all ─────
#
# This is the default: both *_SHA vars are empty unless the operator sets them.
# The failure that matters here is silence — an operator who sees a clean log
# and assumes the pin was checked.
note "no sha given (the default)"
run_pinned_fetch ""
if [[ "$RC" == "0" ]] && [[ -f "$PAYLOAD" ]]; then
    ok "a tag-pinned fetch without a sha still installs"
else
    bad "an unpinned-sha fetch exited $RC / left no file, which would break every default install"
fi
if grep -q 'NOT verified' "$OUT"; then
    ok "and says out loud that it did not verify"
else
    bad "it fetched without verifying and did not say so:
$(sed 's/^/      /' "$OUT")"
fi

# ───── The transport guards ─────
#
# These two flags are the http-downgrade and MITM-via-302 defences. They are
# not observable in the result — a stub answers either way — so they are asked
# of the argv, which is where they either are or are not.
note "transport"
run_pinned_fetch "$GOOD_SHA"
if grep -q -- "--proto =https" "$CURL_LOG"; then
    ok "curl is told https only (no http:// downgrade)"
else
    bad "--proto =https never reached curl; argv was:
$(sed 's/^/      /' "$CURL_LOG")"
fi
if grep -q -- "--max-redirs 0" "$CURL_LOG"; then
    ok "curl is told to follow no redirects (no MITM via 302)"
else
    bad "--max-redirs 0 never reached curl; argv was:
$(sed 's/^/      /' "$CURL_LOG")"
fi
if grep -q -- "-o ${PAYLOAD}" "$CURL_LOG" && grep -q -- "$URL" "$CURL_LOG"; then
    ok "and the url and destination it was given are the ones it was asked for"
else
    bad "url/destination did not reach curl unchanged:
$(sed 's/^/      /' "$CURL_LOG")"
fi

# ───── A download that fails ─────
note "download failure"
CURL_RC=22
run_pinned_fetch "$GOOD_SHA"
CURL_RC=0
if [[ "$RC" != "0" ]] && grep -q 'download failed' "$OUT"; then
    ok "a failed download stops the install and names the url"
else
    bad "a failed download exited $RC and said:
$(sed 's/^/      /' "$OUT")"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  The apt-lock decision, made twice
# ═════════════════════════════════════════════════════════════════════════════
#
# Both installers carry their own copy of `cleanup_stale_apt_locks`, and the
# panel one states the rule in a comment: "a lock file that exists but has no
# process holding it (fuser empty) is stale". `fuser` ships in psmisc, neither
# installer installs it, and a Debian cloud/minbase image can be without it.
# On such a host `fuser` is not "empty because nobody holds the lock", it is
# empty because there is no fuser — and the two are indistinguishable to the
# code, so every apt lock gets removed, including one a running apt is holding.
#
# The function is extracted and run against tmpfs lock files inside a mount
# namespace: nothing here can reach this host's /var/lib/dpkg.
note "cleanup_stale_apt_locks (both installers)"

if ! unshare -rm true 2>/dev/null; then
    bad "no user+mount namespaces on this host; the lock cases cannot be run in isolation and are NOT being skipped silently"
else

LOCKS="${WORK}/locks"
mkdir -p "$LOCKS"

# The stub `fuser` answers what it is told to and records that it was asked;
# hiding it from PATH is the "psmisc is not installed" case.
cat > "${BIN}/fuser" <<'STUB'
#!/usr/bin/env bash
[[ -n "${FAKE_FUSER_HOLDER:-}" ]] && printf '%s\n' "$FAKE_FUSER_HOLDER"
exit 0
STUB
chmod +x "${BIN}/fuser"

cat > "${BIN}/dpkg" <<'STUB'
#!/usr/bin/env bash
printf 'dpkg %s\n' "$*" >> "${FAKE_DPKG_LOG:-/dev/null}"
exit 0
STUB
chmod +x "${BIN}/dpkg"

# Runs one installer's real cleanup_stale_apt_locks over tmpfs copies of the
# four lock paths. $1 = installer, $2 = holder pid to report (empty = none),
# $3 = "hide" to take fuser off PATH entirely.
LOCK_OUT="${WORK}/lock-out.txt"
LOCK_SURVIVORS="${WORK}/survivors.txt"
run_cleanup_locks() {
    local installer="$1" holder="${2-}" hide="${3-}"
    local fn="${WORK}/cleanup.sh"
    {
        grep -E '^(log|warn|fail)\(\) +\{.*\}$' "$installer"
        sed -n '/^cleanup_stale_apt_locks()/,/^}/p' "$installer"
    } > "$fn"
    grep -q 'lock-frontend' "$fn" || { bad "could not cut cleanup_stale_apt_locks out of $installer"; return; }

    # "hide fuser" has to mean a PATH with no fuser ANYWHERE on it. Dropping
    # the stub while /usr/bin is still on PATH just finds the system fuser —
    # which answers about this machine's locks, and the case would pass for a
    # reason that has nothing to do with the code. So the hidden run gets a
    # PATH of exactly one directory, carrying its own copies of the externals
    # the function reaches for.
    local use_path="${BIN}:${PATH}"
    if [[ "$hide" == "hide" ]]; then
        local binpath="${WORK}/bin-nofuser"
        rm -rf "$binpath"; mkdir -p "$binpath"
        ln -sf "${BIN}/dpkg" "${binpath}/dpkg"
        for tool in rm mkdir cat printf; do
            t="$(command -v "$tool" 2>/dev/null)" && ln -sf "$t" "${binpath}/${tool}"
        done
        use_path="$binpath"
    fi

    unshare -rm bash -c '
        set -uo pipefail
        for d in /var/lib/dpkg /var/lib/apt /var/cache/apt; do
            mkdir -p "$d" 2>/dev/null || true
            mount -t tmpfs tmpfs "$d" || exit 90
        done
        mkdir -p /var/lib/apt/lists /var/cache/apt/archives
        : > /var/lib/dpkg/lock-frontend
        : > /var/lib/dpkg/lock
        : > /var/lib/apt/lists/lock
        : > /var/cache/apt/archives/lock
        export PATH="$2"
        export FAKE_FUSER_HOLDER="$3" FAKE_DPKG_LOG="$4"
        # The harness reports what the code could see, not what it was meant
        # to see: a hidden stub that the system PATH still satisfies is the
        # commonest way one of these cases passes while proving nothing.
        if command -v fuser >/dev/null 2>&1; then echo "FUSER_VISIBLE=yes"; else echo "FUSER_VISIBLE=no"; fi
        # shellcheck source=/dev/null
        source "$1"
        cleanup_stale_apt_locks
        for f in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \
                 /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do
            [[ -e "$f" ]] && printf "%s\n" "$f"
        done > "$5"
        exit 0
    ' _ "$fn" "$use_path" "$holder" "${WORK}/dpkg.log" "$LOCK_SURVIVORS" >"$LOCK_OUT" 2>&1
}

for installer in "$NODE_INSTALLER" "$PANEL_INSTALLER"; do
    name="$(basename "$installer")"

    # Control first: with a holder reported, the locks must survive. If this
    # case failed, "the lock survived" below would mean nothing.
    : > "$LOCK_SURVIVORS"
    run_cleanup_locks "$installer" "1234" ""
    if [[ "$(wc -l <"$LOCK_SURVIVORS")" == "4" ]]; then
        ok "${name}: a lock a process is holding is left alone"
    else
        bad "${name}: a held lock was removed; survivors were:
$(sed 's/^/      /' "$LOCK_SURVIVORS")
$(sed 's/^/      /' "$LOCK_OUT")"
    fi

    # ...and the other control: it must really remove a genuinely stale one,
    # or "the lock survived" is true of a function that does nothing.
    : > "$LOCK_SURVIVORS"
    run_cleanup_locks "$installer" "" ""
    if [[ ! -s "$LOCK_SURVIVORS" ]]; then
        ok "${name}: a lock nobody holds is removed, which is what it is for"
    else
        bad "${name}: a stale lock was kept:
$(sed 's/^/      /' "$LOCK_SURVIVORS")"
    fi

    # The case itself.
    : > "$LOCK_SURVIVORS"
    run_cleanup_locks "$installer" "" "hide"
    if grep -q 'FUSER_VISIBLE=no' "$LOCK_OUT"; then
        ok "${name}: the no-psmisc run really had no fuser on its PATH"
    else
        bad "${name}: fuser was still reachable, so the next case says nothing:
$(sed 's/^/      /' "$LOCK_OUT")"
    fi
    if [[ "$(wc -l <"$LOCK_SURVIVORS")" == "4" ]]; then
        ok "${name}: with no fuser installed the locks are NOT removed"
    else
        bad "${name}: on a host without psmisc every apt lock was deleted, including one a running apt may hold. Survivors:
$(sed 's/^/      /' "$LOCK_SURVIVORS")"
    fi
done

fi   # namespaces available

# ═════════════════════════════════════════════════════════════════════════════
#  install-iceslab-node.sh: the prologue, run for real
# ═════════════════════════════════════════════════════════════════════════════
#
# Argument parsing and the `--uninstall` fast-path are executable body, not
# functions, so they cannot be cut out and sourced. They are run instead — the
# whole real script, from `set -euo pipefail` down to whichever exit the flags
# reach — inside `unshare -rm`, where EUID is 0 (so the root check passes
# honestly rather than by editing it out) and /var/run, /var/lib/dpkg,
# /var/lib/apt and /var/cache/apt are tmpfs. Nothing the run does can reach
# this host.
#
# The one branch that must never run here is `do_uninstall`: it stops units and
# removes /etc/xray/config.json on whatever host it is on. It is guarded by
# "is there a prior install", so the harness refuses to start if there is one.
note "install-iceslab-node.sh prologue"

if [[ -e /etc/iceslab-node/env || -x /usr/local/bin/iceslab-node ]]; then
    bad "this host HAS an iceslab node installed; --uninstall would really uninstall it. Refusing to run the prologue cases."
elif ! unshare -rm true 2>/dev/null; then
    bad "no user+mount namespaces; the prologue cases cannot be isolated and are NOT being skipped silently"
else

cat > "${BIN}/systemctl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "${BIN}/systemctl"

INST_OUT="${WORK}/inst-out.txt"
INST_RC=0
run_installer() {
    unshare -rm bash -c '
        set -uo pipefail
        mount -t tmpfs tmpfs /var/run || exit 90
        for d in /var/lib/dpkg /var/lib/apt /var/cache/apt; do
            mkdir -p "$d" 2>/dev/null || true
            mount -t tmpfs tmpfs "$d" || exit 90
        done
        mkdir -p /var/lib/apt/lists /var/cache/apt/archives
        : > /var/lib/dpkg/lock-frontend
        export PATH="$1:$PATH"
        export FAKE_CURL_LOG="$2" FAKE_CURL_BODY="" FAKE_CURL_RC=0
        export FAKE_DPKG_LOG="$3" FAKE_FUSER_HOLDER=""
        installer="$4"; shift 4
        bash "$installer" "$@"
        rc=$?
        # What survived is part of the answer, so it is reported out of the
        # namespace rather than inspected after it is gone.
        [[ -e /var/lib/dpkg/lock-frontend ]] && echo "APT_LOCK_SURVIVED"
        exit $rc
    ' _ "$BIN" "$CURL_LOG" "${WORK}/dpkg.log" "$NODE_INSTALLER" "$@" >"$INST_OUT" 2>&1
    INST_RC=$?
}

: > "$CURL_LOG"; : > "${WORK}/dpkg.log"

# Control: the run has to get as far as the parser, or every case is vacuous.
run_installer --help
if [[ "$INST_RC" == "0" ]] && grep -q 'one-command installer' "$INST_OUT"; then
    ok "--help prints the usage and exits 0"
else
    bad "--help exited $INST_RC and said:
$(sed 's/^/      /' "$INST_OUT")"
fi

run_installer --definitely-not-a-flag
if [[ "$INST_RC" != "0" ]] && grep -q 'Unknown arg: --definitely-not-a-flag' "$INST_OUT"; then
    ok "an unknown flag is refused by name"
else
    bad "an unknown flag exited $INST_RC and said:
$(sed 's/^/      /' "$INST_OUT")"
fi

# ───── --uninstall on a machine with nothing installed ─────
run_installer --uninstall
if [[ "$INST_RC" == "0" ]] && grep -q 'Nothing to uninstall' "$INST_OUT"; then
    ok "--uninstall with no prior install says so and exits 0"
else
    bad "--uninstall on a clean box exited $INST_RC and said:
$(sed 's/^/      /' "$INST_OUT")"
fi

# The reason that branch is placed first, stated in the code: it must not burn
# the one-shot bootstrap token. The observable is that nothing was sent.
: > "$CURL_LOG"
run_installer --bootstrap not-a-real-token --uninstall
if [[ "$INST_RC" == "0" ]] && [[ ! -s "$CURL_LOG" ]]; then
    ok "--uninstall spends no bootstrap token: the panel is never called"
else
    bad "--uninstall exited $INST_RC and made these calls:
$(sed 's/^/      /' "$CURL_LOG")"
fi

# ───── ...and it must not perform apt surgery on the way there ─────
#
# `cleanup_stale_apt_locks` used to be invoked at load time, above the parser,
# so both read-only-looking flags removed this host's dpkg locks and ran
# `dpkg --configure -a` before deciding they had nothing to do.
for flag in --help --uninstall; do
    : > "${WORK}/dpkg.log"
    run_installer "$flag"
    if grep -q 'APT_LOCK_SURVIVED' "$INST_OUT" && [[ ! -s "${WORK}/dpkg.log" ]]; then
        ok "$flag leaves the machine's apt state alone"
    else
        bad "$flag rewrote apt state before reading its own arguments: lock removed=$(grep -qc 'APT_LOCK_SURVIVED' "$INST_OUT" >/dev/null && echo no || echo yes), dpkg calls:
$(sed 's/^/      /' "${WORK}/dpkg.log")"
    fi
done

# ───── Every value-taking flag must eat its value ─────
#
# The flag list is read out of the parser, not copied here: a flag added later
# is covered without anyone remembering to add it. A missing `shift 2` shows up
# as the VALUE arriving at the `*)` arm — "Unknown arg: 1.2.3.4" — so appending
# --uninstall gives each run a place to stop that is not an install.
VALUE_FLAGS=$(sed -n '/^while \[\[ \$# -gt 0 \]\]; do/,/^done$/p' "$NODE_INSTALLER" \
    | grep -oE '^\s+--[a-z0-9-]+\)[^;]*;\s*shift 2\b' \
    | grep -oE '\-\-[a-z0-9-]+')
flag_count=$(printf '%s\n' "$VALUE_FLAGS" | grep -c .)
if [[ "$flag_count" -ge 10 ]]; then
    ok "read $flag_count value-taking flags out of the parser"
else
    bad "only $flag_count value-taking flags were found; the parser was reshaped and this case is nearly empty"
fi

TOKFILE="${WORK}/tokenfile"
printf 'a-token\n' > "$TOKFILE"
missed=""
for flag in $VALUE_FLAGS; do
    case "$flag" in
        --payload-file|--bootstrap-file) value="$TOKFILE" ;;
        *)                               value="1.2.3.4"  ;;
    esac
    run_installer "$flag" "$value" --uninstall
    if [[ "$INST_RC" != "0" ]] || ! grep -q 'Nothing to uninstall' "$INST_OUT"; then
        missed="${missed} ${flag}"
    fi
done
if [[ -z "$missed" ]]; then
    ok "all $flag_count of them consume their value (no value reaches the unknown-arg arm)"
else
    bad "these flags left their value on the command line:${missed}"
fi

# ───── resolve_payload / resolve_bootstrap ─────
#
# Both exist to keep a secret off the command line and to survive a careless
# save; the whitespace-stripping is the part that is easy to lose.
note "payload and bootstrap files"
RES="${WORK}/resolve.sh"
{
    grep -E '^(log|warn|fail)\(\) +\{.*\}$' "$NODE_INSTALLER"
    sed -n '/^resolve_payload()/,/^}/p' "$NODE_INSTALLER"
    sed -n '/^resolve_bootstrap()/,/^}/p' "$NODE_INSTALLER"
} > "$RES"

MESSY="${WORK}/messy.txt"
printf '  eyJhbGciOi\nJIUzI1NiJ9  \r\n' > "$MESSY"
got="$(bash -c 'source "$1"; resolve_payload "@$2"' _ "$RES" "$MESSY" 2>&1)"
if [[ "$got" == "eyJhbGciOiJIUzI1NiJ9" ]]; then
    ok "a payload file saved with stray newlines and spaces still resolves"
else
    bad "resolve_payload returned [$got]"
fi
got="$(bash -c 'source "$1"; resolve_bootstrap "$2"' _ "$RES" "$MESSY" 2>&1)"
if [[ "$got" == "eyJhbGciOiJIUzI1NiJ9" ]]; then
    ok "and so does a bootstrap file"
else
    bad "resolve_bootstrap returned [$got]"
fi
got="$(bash -c 'source "$1"; resolve_payload "$2"' _ "$RES" "inline-payload" 2>&1)"
if [[ "$got" == "inline-payload" ]]; then
    ok "an inline payload is passed through unchanged"
else
    bad "an inline payload came back as [$got]"
fi
if ! bash -c 'source "$1"; resolve_bootstrap "$2"' _ "$RES" "${WORK}/no-such-file" >/dev/null 2>&1; then
    ok "an unreadable bootstrap file stops the install rather than installing with an empty token"
else
    bad "a missing bootstrap file was accepted"
fi

fi   # prologue cases

# ───── fmt_duration ─────
#
# Only ever read by a human, and read at the moment something has gone wrong.
note "fmt_duration"
FMT="${WORK}/fmt.sh"
sed -n '/^fmt_duration()/,/^}/p' "$NODE_INSTALLER" > "$FMT"
fmt_fail=""
while read -r secs want; do
    [[ -n "$secs" ]] || continue
    got="$(bash -c 'source "$1"; fmt_duration "$2"' _ "$FMT" "$secs" 2>&1)"
    [[ "$got" == "$want" ]] || fmt_fail="${fmt_fail}
      ${secs}s -> [$got], wanted [$want]"
done <<'CASES'
0 0s
9 9s
59 59s
60 1m00s
61 1m01s
187 3m07s
3599 59m59s
3600 60m00s
CASES
if [[ -z "$fmt_fail" ]]; then
    ok "seconds render as an operator would read them"
else
    bad "fmt_duration:${fmt_fail}"
fi

# ───── The functions both installers carry a copy of ─────
#
# `fmt_duration` and `cleanup_stale_apt_locks` are the same decision written
# out twice, in two files, with no link between them. Comments differ on
# purpose (the panel copy documents the format); code that differs is one copy
# having been fixed and the other not — which is how the fuser hole would come
# back on one side only.
note "the two installers' shared copies"
for fn in fmt_duration cleanup_stale_apt_locks; do
    a="$(sed -n "/^${fn}()/,/^}/p" "$PANEL_INSTALLER" | grep -vE '^\s*#' )"
    b="$(sed -n "/^${fn}()/,/^}/p" "$NODE_INSTALLER"  | grep -vE '^\s*#' )"
    if [[ -n "$a" && "$a" == "$b" ]]; then
        ok "${fn} is byte-identical in both installers"
    else
        bad "${fn} has drifted between the installers:
$(diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | sed 's/^/      /')"
    fi
done

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
