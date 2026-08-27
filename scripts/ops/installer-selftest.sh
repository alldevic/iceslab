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
# Needs bash, coreutils, and — for the bootstrap-redemption cases only —
# python3, openssl and setsid, to stand up a throwaway HTTPS panel on loopback.
# No docker, no systemd, and nothing that leaves this machine. `do_uninstall`
# stops units and removes /etc/xray on whatever host it is on, so it is run only
# inside `unshare -rm`, and the harness refuses to start on a host that has a
# node installed.
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

CORE_FUNCS="${WORK}/core-funcs.sh"
{
    printf 'log()  { :; }\n'
    printf 'warn() { :; }\n'
    printf 'fail() { printf "FAIL: %%s\\n" "$*" >&2; exit 1; }\n'
    sed -n '/^payload_field()/,/^}/p' "$NODE_INSTALLER"
    sed -n '/^panel_core_fetch()/,/^}/p' "$NODE_INSTALLER"
} > "$CORE_FUNCS"

if grep -q '^panel_core_fetch()' "$CORE_FUNCS" && grep -q 'sha256sum' "$CORE_FUNCS"; then
    ok "panel_core_fetch's real body was extracted from the installer"
else
    bad "could not cut panel_core_fetch out of ${NODE_INSTALLER}; every case below would be vacuous"
fi

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

# ───── Every flag's value must reach something ─────
#
# The two directions above are about NAMES: --help and the parser hold the same
# list. Neither says the value goes anywhere. `--xray-reality-public-key` passed
# both for months — parsed into XR_PUBLIC_KEY, and XR_PUBLIC_KEY was read by no
# line in the file. The pass that closed the name gap gave it a --help paragraph
# saying the node "records" it, which made the mirror green and the promise
# false: an operator handing the installer their public key watched it go
# nowhere. So the third question is asked here, of the variable rather than the
# flag, and comments are stripped first — a variable mentioned only in prose
# about itself is exactly the shape being looked for.
note "what the flags do with their values"
PARSER_BLOCK=$(sed -n '/^while \[\[ \$# -gt 0 \]\]; do/,/^done$/p' "$NODE_INSTALLER")
FLAG_VARS=$(grep -oE '^\s+--[a-z0-9-]+\)\s+[A-Z_]+=' <<<"$PARSER_BLOCK" \
    | grep -oE '[A-Z_]+=' | tr -d '=' | sort -u)
var_count=$(printf '%s\n' "$FLAG_VARS" | grep -c .)
if [[ "$var_count" -ge 15 ]] && grep -qx 'PROTOCOL' <<<"$FLAG_VARS"; then
    ok "read $var_count variables the flags assign to"
else
    bad "only $var_count flag variables parsed out (PROTOCOL among them: $(grep -qx PROTOCOL <<<"$FLAG_VARS" && echo yes || echo no)); this case is nearly empty"
fi
# Everything except the parser arm that assigns it, with comments removed.
BODY_NO_COMMENTS=$(grep -v '^\s*#' "$NODE_INSTALLER" | grep -vE '^\s+--[a-z0-9-]+\)\s+[A-Z_]+=')
unread=""
for v in $FLAG_VARS; do
    grep -qE "\\\$\{?${v}\b" <<<"$BODY_NO_COMMENTS" || unread="${unread} ${v}"
done
if [[ -z "${unread// /}" ]]; then
    ok "and every one of them is read somewhere outside the parser"
else
    bad "these flags accept a value the script then never reads:${unread}"
fi

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

# ───── --help and the parser must name the same flags ─────
#
# `--help` prints the script's own header comments, so the usage text and the
# code are two copies of one list with nothing linking them. Both directions
# matter and they fail differently: a flag documented and not parsed is an
# operator following our instructions into `Unknown arg`, and a flag parsed and
# not documented is a control nobody knows exists — which is what --panel-ip
# was, the flag that keeps the agent's mTLS port off the open internet.
HELP_END=$(grep -n '^set -euo pipefail' "$NODE_INSTALLER" | head -1 | cut -d: -f1)
DOC_FLAGS=$(sed -n "1,$((HELP_END - 1))p" "$NODE_INSTALLER" | grep -oE '\-\-[a-z][a-z0-9-]+' | sort -u)
PARSED_FLAGS=$(sed -n '/^while \[\[ \$# -gt 0 \]\]; do/,/^done$/p' "$NODE_INSTALLER" \
    | grep -oE '^\s+(-h\|)?--[a-z0-9-]+\)' | grep -oE '\-\-[a-z0-9-]+' | sort -u)
undocumented=$(comm -13 <(printf '%s\n' "$DOC_FLAGS") <(printf '%s\n' "$PARSED_FLAGS") | tr '\n' ' ')
unparsed=$(comm -23 <(printf '%s\n' "$DOC_FLAGS") <(printf '%s\n' "$PARSED_FLAGS") | tr '\n' ' ')
if [[ -z "${unparsed// /}" ]]; then
    ok "every flag --help offers is one the parser accepts"
else
    bad "--help documents flags the parser rejects: ${unparsed}"
fi
if [[ -z "${undocumented// /}" ]]; then
    ok "and every flag the parser accepts is one --help mentions"
else
    bad "the parser accepts flags --help never mentions: ${undocumented}"
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

# ═════════════════════════════════════════════════════════════════════════════
#  Redeeming a bootstrap token, against a panel that answers
# ═════════════════════════════════════════════════════════════════════════════
#
# The recommended way to install a node is `--panel-url X --bootstrap TOK`: the
# installer GETs the token and the panel hands back the mTLS payload. Forty
# lines, five outcomes, each with its own message — and not one of them had ever
# run. The cases above cover the flag PARSING and the file-reading helper; what
# happens after is executable body in the middle of the script.
#
# The five are not interchangeable, and the operator has nothing but the message
# to act on: 404 means the token is wrong or purged (re-read the command), 410
# means it was already spent (issue a new one in the panel), 000 means the box
# cannot reach the panel at all (URL, TLS, firewall), anything else means look
# at the panel's log. Getting one of those wrong sends the operator to the wrong
# place with a node that is not installed. The block also carries a repaired
# bug in its comment — `curl -f` made "410" arrive as "410000" and fall through
# to the catch-all — which is precisely a code-to-message mapping that only a
# real reply can check.
#
# So the panel is real here: a throwaway HTTPS server on loopback with a
# self-signed cert, and curl is the REAL curl, pointed at that cert through
# CURL_CA_BUNDLE. Nothing else would exercise `--proto =https`, `--max-redirs 0`
# or the http_code parsing; a stubbed curl would only be asking the harness what
# it had just been told.
#
# The installer is run with no --protocol and in its own session, so that the
# first thing after the redemption block — the interactive protocol menu — has
# no /dev/tty to read from and stops the run there. That is the whole point: the
# redemption happens, and nothing after it does.
note "bootstrap token redemption"

BS_LOG="${WORK}/panel-requests.log"
BS_PORT_FILE="${WORK}/panel-port"
BS_CERT="${WORK}/panel-cert.pem"
BS_KEY="${WORK}/panel-key.pem"
BS_PID=""

# Real curl, everything else still stubbed: cleanup_stale_apt_locks runs before
# the redemption and wants fuser/dpkg, and those must stay fake.
BIN_REAL="${WORK}/bin-real"
mkdir -p "$BIN_REAL"
for f in "$BIN"/*; do
    [[ "$(basename "$f")" == "curl" ]] && continue
    ln -sf "$f" "${BIN_REAL}/$(basename "$f")"
done

bs_stop() { [[ -n "$BS_PID" ]] && kill "$BS_PID" 2>/dev/null; BS_PID=""; }
trap 'bs_stop; rm -rf "$WORK"' EXIT

if ! command -v python3 >/dev/null; then
    bad "python3 is missing, so the panel stub cannot be started; the redemption cases are NOT being skipped silently"
elif ! command -v openssl >/dev/null; then
    bad "openssl is missing, so no cert can be made for the panel stub; the redemption cases are NOT being skipped silently"
elif ! command -v setsid >/dev/null; then
    bad "setsid is missing; without a session of its own the installer would hang on the protocol menu. NOT skipping silently"
else

# IP:127.0.0.1 rather than DNS:localhost on purpose. `localhost` resolves to ::1
# first on this machine, the stub binds v4, and the run would fail for a reason
# that has nothing to do with the installer.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj '/CN=iceslab-panel-stub' -addext 'subjectAltName=IP:127.0.0.1' \
    -keyout "$BS_KEY" -out "$BS_CERT" >/dev/null 2>&1

cat > "${WORK}/panel-stub.py" <<'PYEOF'
import hashlib, http.server, ssl, sys, textwrap

cert, key, reqlog, portfile = sys.argv[1:5]
PAYLOAD = "A" * 6000

class Panel(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        with open(reqlog, "a") as f:
            f.write(self.path + "\n")
        # Two core downloads: one whose sha256 header matches the body and one
        # whose does not. The second is the case that matters — the installer
        # must refuse it and leave nothing on disk.
        if self.path.startswith("/api/internal/cores/"):
            body = b"pretend this is a proxy core\n"
            good = hashlib.sha256(body).hexdigest()
            honest = "honest" in self.path
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Iceslab-Sha256", good if honest else "0" * 64)
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path in ("/api/internal/bootstrap/good-token",
                         "/api/internal/bootstrap/token-from-a-file"):
            # Line-wrapped, the way base64 comes out of most tools, plus a
            # trailing newline. A trailing newline alone would prove nothing:
            # `$(...)` eats those on its own. The wrapping is what the
            # installer's `tr -d` is for, and a payload that reaches the env
            # file with newlines still in it is a node that never starts.
            body = (textwrap.fill(PAYLOAD, 76) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/internal/bootstrap/moved-token":
            # What --max-redirs 0 exists for: a panel URL under someone else's
            # control bouncing the redemption at a host of their choosing.
            self.send_response(302)
            self.send_header("Location", "/api/internal/bootstrap/good-token")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/api/internal/bootstrap/unknown-token":
            self.send_error(404)
        elif self.path == "/api/internal/bootstrap/spent-token":
            self.send_error(410)
        else:
            self.send_error(418)

srv = http.server.HTTPServer(("127.0.0.1", 0), Panel)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
with open(portfile, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF

: > "$BS_LOG"
rm -f "$BS_PORT_FILE"
python3 "${WORK}/panel-stub.py" "$BS_CERT" "$BS_KEY" "$BS_LOG" "$BS_PORT_FILE" >/dev/null 2>&1 &
BS_PID=$!
for _ in $(seq 1 50); do
    [[ -s "$BS_PORT_FILE" ]] && break
    sleep 0.1
done
BS_PORT="$(cat "$BS_PORT_FILE" 2>/dev/null || true)"

# The harness's own control, and it has to be a real redemption-shaped request:
# a stub that answers nothing would make every "the installer failed" case below
# pass for the wrong reason.
if [[ -n "$BS_PORT" ]] \
   && curl --cacert "$BS_CERT" -sS -o /dev/null -w '%{http_code}' \
        "https://127.0.0.1:${BS_PORT}/api/internal/bootstrap/good-token" 2>/dev/null \
      | grep -q '^200$'; then
    ok "a panel stub is answering 200 on https://127.0.0.1:${BS_PORT}"
else
    bad "the panel stub never came up (port='${BS_PORT}'); the redemption cases would all pass for the wrong reason"
fi

BS_OUT="${WORK}/bootstrap-out.txt"
BS_RC=0
# Same isolation as run_installer, with real curl on PATH, the stub's cert as
# curl's trust store, and a session of its own so the protocol menu cannot read
# a terminal.
redeem() {
    _redeem 0 "$@"
}

# The same run on a box that already has an agent. The marker is
# /usr/local/bin/iceslab-node, and the tmpfs over /usr/local/bin is what keeps
# the pretence inside the namespace — nothing the installer needs before the
# redemption lives there (curl, mktemp and bash are in /usr/bin, and the stubs
# come first on PATH), so hiding it costs nothing.
redeem_with_prior_install() {
    _redeem 1 "$@"
}

_redeem() {
    local prior="$1"; shift
    unshare -rm bash -c '
        set -uo pipefail
        mount -t tmpfs tmpfs /var/run || exit 90
        for d in /var/lib/dpkg /var/lib/apt /var/cache/apt; do
            mkdir -p "$d" 2>/dev/null || true
            mount -t tmpfs tmpfs "$d" || exit 90
        done
        mkdir -p /var/lib/apt/lists /var/cache/apt/archives
        if [[ "$5" == "1" ]]; then
            mount -t tmpfs tmpfs /usr/local/bin || exit 90
            printf "#!/bin/sh\nexit 0\n" > /usr/local/bin/iceslab-node
            chmod 0755 /usr/local/bin/iceslab-node
        fi
        export PATH="$1:$PATH"
        export CURL_CA_BUNDLE="$2"
        export FAKE_DPKG_LOG="$3" FAKE_FUSER_HOLDER=""
        installer="$4"; shift 5
        setsid --wait bash "$installer" "$@"
    ' _ "$BIN_REAL" "$BS_CERT" "${WORK}/dpkg.log" "$NODE_INSTALLER" "$prior" "$@" >"$BS_OUT" 2>&1
    BS_RC=$?
}

# ───── 200: the payload comes back and the run continues past the block ─────
: > "$BS_LOG"
redeem --panel-url "https://127.0.0.1:${BS_PORT}" --bootstrap good-token
if grep -q 'Bootstrap successful: fetched 6000 bytes of payload' "$BS_OUT"; then
    ok "a valid token is exchanged for the payload, and the line breaks the panel wrapped it in are stripped"
else
    bad "the redemption did not report a 6000-byte payload:
$(sed 's/^/      /' "$BS_OUT" | tail -20)"
fi
# Where the run stopped is the other half: past the redemption, at the first
# thing that needs an operator. If it had stopped earlier the case above would
# be about something else.
if [[ "$BS_RC" != "0" ]] && grep -q 'no /dev/tty; pass --protocol explicitly' "$BS_OUT"; then
    ok "and the run went on to the next step rather than ending at the redemption"
else
    bad "the run ended somewhere unexpected (rc=$BS_RC):
$(sed 's/^/      /' "$BS_OUT" | tail -20)"
fi
if [[ "$(cat "$BS_LOG")" == "/api/internal/bootstrap/good-token" ]]; then
    ok "the panel was asked for exactly that token, at the documented path"
else
    bad "the panel saw these requests instead:
$(sed 's/^/      /' "$BS_LOG")"
fi

# ───── ...and not asked at all when the run is going to refuse anyway ─────
#
# A bootstrap token is one-shot. The `--uninstall` fast-path is placed above the
# redemption for exactly that reason and says so in its own comment — but the
# OTHER thing that refuses to install, the previous-install gate, sat BELOW it
# and burned the token on all three of its exits. The operator then re-ran the
# same copy-pasted command with --reset and was told "Bootstrap token already
# consumed or expired: issue a fresh one in the panel UI", which reads as an
# expiry rather than as "your last attempt spent it".
#
# Watched on a VM, 2026-08-28, with the real panel: abort, then a 410 on the
# retry. The A/B is one difference — the case above and this one send the same
# token to the same server, and only this box has an agent on it.
: > "$BS_LOG"
redeem_with_prior_install --panel-url "https://127.0.0.1:${BS_PORT}" --bootstrap good-token
if [[ "$BS_RC" != "0" ]] && [[ ! -s "$BS_LOG" ]]; then
    ok "a run that refuses because an agent is already installed spends no token: the panel is never called"
else
    bad "the refusal exited $BS_RC and the panel saw:
$(sed 's/^/      /' "$BS_LOG")
$(sed 's/^/      /' "$BS_OUT" | tail -20)"
fi
# The refusal has to be the one we mean, not some other failure that happens to
# come first — and it has to hand the operator the two flags that get past it.
if grep -q -- '--reset' "$BS_OUT" && grep -q -- '--uninstall' "$BS_OUT"; then
    ok "and it names --reset and --uninstall rather than just stopping"
else
    bad "the refusal did not name the way out:
$(sed 's/^/      /' "$BS_OUT" | tail -20)"
fi
# `-e /dev/tty` is true in this session and opening it still fails, so the read
# fails rather than returning what a human typed. Saying "Aborted by user" there
# sent the last reader looking for a user who was never asked.
if grep -q 'Could not read the answer from /dev/tty' "$BS_OUT"; then
    ok "and it says the prompt could not be READ, rather than blaming a user who was never asked"
else
    bad "the message about the unreadable prompt is not the one expected:
$(sed 's/^/      /' "$BS_OUT" | tail -20)"
fi

# ───── --bootstrap-file: the same redemption, no token in argv ─────
#
# The flag exists because `--bootstrap tok` leaves the token in
# /proc/<pid>/cmdline for the length of the install, and within its 15-minute
# TTL that is a full mTLS keypair for this node to any local process. The
# observable is that the panel was asked for the token although the command
# line only ever held a path.
: > "$BS_LOG"
printf 'token-from-a-file\n' > "${WORK}/bs-token"
redeem --panel-url "https://127.0.0.1:${BS_PORT}" --bootstrap-file "${WORK}/bs-token"
if [[ "$(cat "$BS_LOG")" == "/api/internal/bootstrap/token-from-a-file" ]] \
   && grep -q 'Bootstrap successful' "$BS_OUT"; then
    ok "--bootstrap-file redeems the token it read, and the token never appears on the command line"
else
    bad "--bootstrap-file asked the panel for: $(cat "$BS_LOG")
$(sed 's/^/      /' "$BS_OUT" | tail -20)"
fi

# ───── The core download, against the same real server ─────
#
# The sha256 check is the whole security property of moving the download to the
# panel: a node must install the bytes the panel pinned or nothing at all. So it
# is exercised against a server that really answers, in both directions, and the
# refusing case is asked what it LEFT BEHIND as well as what it returned — an
# unverified binary at the destination path is exactly the artefact this is for.
CORE_DEST="${WORK}/fetched-core"
core_fetch() {  # <path-suffix>
    rm -f "$CORE_DEST"
    PAYLOAD="$(printf '%s' "{\"panelUrl\":\"https://127.0.0.1:${BS_PORT}\",\"heartbeatToken\":\"tok\"}" | base64 -w0)" \
    CORE_ARCH="$1" \
    CURL_CA_BUNDLE="$BS_CERT" \
    bash -c 'source "$1"; panel_core_fetch xray "$2"' _ "$CORE_FUNCS" "$CORE_DEST" 2>&1
}

OUT="$(core_fetch honest || true)"
if [[ -f "$CORE_DEST" ]] && [[ "$(cat "$CORE_DEST")" == "pretend this is a proxy core" ]]; then
    ok "a core whose sha256 matches the panel's header is written to disk"
else
    bad "the honest download did not land: ${OUT}"
fi

OUT="$(core_fetch amd64 || true)"
if [[ ! -f "$CORE_DEST" ]] && grep -q 'sha256' <<<"$OUT"; then
    ok "and one whose sha256 does NOT match is refused, with nothing left at the destination"
else
    bad "the mismatching download left $(ls -la "$CORE_DEST" 2>/dev/null || echo 'nothing') and said: ${OUT}"
fi

# ───── 404, 410, 418, 000: four codes, four different things to do ─────
# A failed redemption must also STOP the install rather than carry on with an
# empty payload, so each case asks for both: the right message, and a run that
# never reached the protocol menu the 200 case does reach.
bs_case() {
    local token="$1" want_msg="$2" label="$3" url="${4:-https://127.0.0.1:${BS_PORT}}"
    : > "$BS_LOG"
    redeem --panel-url "$url" --bootstrap "$token"
    if [[ "$BS_RC" != "0" ]] && grep -qF "$want_msg" "$BS_OUT" \
       && ! grep -q 'pass --protocol explicitly' "$BS_OUT"; then
        ok "$label"
    else
        bad "${label} — exited $BS_RC and said:
$(sed 's/^/      /' "$BS_OUT" | tail -12)"
    fi
}

bs_case unknown-token 'Bootstrap token not found' \
    "404 says the token is unknown and points at typo-or-purged"
bs_case spent-token 'already consumed or expired' \
    "410 says the token was spent and to issue a fresh one"
bs_case teapot-token 'Unexpected HTTP 418' \
    "an unexpected code is reported with the code itself, not swallowed"
bs_case moved-token 'Unexpected HTTP 302' \
    "a 302 is refused rather than followed: a hostile --panel-url cannot bounce the keypair handoff"
bs_case any-token 'Cannot reach panel' \
    "an unreachable panel is told apart from an answering one" "https://127.0.0.1:1"

# ───── The guards around the request itself ─────
: > "$BS_LOG"
redeem --panel-url "http://127.0.0.1:${BS_PORT}" --bootstrap good-token
if [[ "$BS_RC" != "0" ]] && grep -q 'must start with https://' "$BS_OUT" && [[ ! -s "$BS_LOG" ]]; then
    ok "a plain-http panel URL is refused before anything is sent"
else
    bad "an http:// panel URL exited $BS_RC, and the panel saw: $(cat "$BS_LOG")
$(sed 's/^/      /' "$BS_OUT" | tail -12)"
fi
for half in "--panel-url https://127.0.0.1:${BS_PORT}" "--bootstrap good-token"; do
    : > "$BS_LOG"
    # shellcheck disable=SC2086
    redeem $half
    if [[ "$BS_RC" != "0" ]] && grep -q 'must be passed TOGETHER' "$BS_OUT"; then
        ok "'${half%% *}' alone is refused by name"
    else
        bad "'${half%% *}' alone exited $BS_RC:
$(sed 's/^/      /' "$BS_OUT" | tail -12)"
    fi
done

bs_stop
fi   # bootstrap redemption cases


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

# ═════════════════════════════════════════════════════════════════════════════
#  do_uninstall: what it removes, and what it must not
# ═════════════════════════════════════════════════════════════════════════════
#
# Fifty lines of `rm -f` and `rm -rf` that no test has ever read, and the branch
# the harness above refuses to let anywhere near this host. Both directions
# matter and only one of them is obvious: it has to remove what this installer
# put down, AND it has to leave alone what it did not. The second is the one
# that bites, because an uninstall that takes a neighbouring subsystem's config
# with it is discovered later, by whatever stopped working.
#
# Run inside `unshare -rm` with tmpfs over every path it touches, so the real
# function runs against real files and this machine's /etc is untouchable.
note "do_uninstall"

if ! unshare -rm true 2>/dev/null; then
    bad "no user+mount namespaces; do_uninstall cannot be isolated and is NOT being skipped silently"
else

UNINST_OUT="${WORK}/uninstall-out.txt"
SURVIVORS="${WORK}/uninstall-survivors.txt"

cat > "${BIN}/ufw" <<'STUB'
#!/usr/bin/env bash
printf 'ufw %s\n' "$*" >> "${FAKE_UFW_LOG:-/dev/null}"
# `status` is what do_uninstall reads to decide which rules exist. Configurable
# so a case can put a realistic set of leftovers in front of it — including an
# address-scoped rule, which is a DIFFERENT rule and must survive.
[[ "$1" == "status" ]] && printf '%s\n' "${FAKE_UFW_STATUS:-1337/tcp                   ALLOW       Anywhere}"
exit 0
STUB
chmod +x "${BIN}/ufw"

run_do_uninstall() {
    : > "$SURVIVORS"
    {
        grep -E '^(log|warn|fail)\(\) +\{.*\}$' "$NODE_INSTALLER"
        sed -n '/^do_uninstall()/,/^}/p' "$NODE_INSTALLER"
    } > "${WORK}/uninstall.sh"
    grep -q 'Removing binary' "${WORK}/uninstall.sh" \
        || { bad "could not cut do_uninstall out of the installer"; return; }

    unshare -rm bash -c '
        set -uo pipefail
        # tmpfs goes over /etc and /usr/local, not over their subdirectories:
        # half of those do not exist on a machine with no node installed, and a
        # userns root cannot mkdir inside the real /etc to create them. The
        # first version of this did exactly that, mounted nothing, and the
        # control below caught it reporting on the real /etc of this machine.
        mount -t tmpfs tmpfs /etc || exit 90
        mount -t tmpfs tmpfs /usr/local || exit 90
        mkdir -p /etc/systemd/system/iceslab-node.service.d /etc/iceslab-node \
                 /etc/hysteria /etc/xray /etc/fail2ban/jail.d /etc/fail2ban/filter.d \
                 /usr/local/bin

        # ── what this installer put down ──
        : > /etc/systemd/system/iceslab-node.service
        : > /etc/systemd/system/iceslab-node.service.d/override.conf
        : > /etc/systemd/system/hysteria.service
        : > /etc/systemd/system/iceslab-hyhop.service
        : > /etc/hysteria/config.yaml
        : > /etc/xray/config.json
        : > /usr/local/bin/iceslab-node
        : > /usr/local/bin/iceslab-hyhop
        : > /etc/iceslab-node/env
        : > /etc/fail2ban/jail.d/iceslab.local
        : > /etc/fail2ban/filter.d/iceslab-hysteria.conf
        checkout=/tmp/iceslab-node-src; mkdir -p "$checkout"; : > "$checkout/go.mod"

        # ── what it did NOT, and must not touch ──
        : > /etc/systemd/system/nginx.service
        : > /etc/xray/keys.json
        : > /etc/fail2ban/jail.local
        : > /etc/fail2ban/jail.d/sshd-custom.local
        : > /usr/local/bin/some-other-tool

        export PATH="$1:$PATH"
        export FAKE_UFW_LOG="$2"
        ICESLAB_NODE_DIR="$checkout"
        NODE_PORT=1337
        # shellcheck source=/dev/null
        source "$3"
        do_uninstall

        for f in /etc/systemd/system/iceslab-node.service \
                 /etc/systemd/system/iceslab-node.service.d \
                 /etc/systemd/system/hysteria.service \
                 /etc/systemd/system/iceslab-hyhop.service \
                 /etc/hysteria/config.yaml /etc/xray/config.json \
                 /usr/local/bin/iceslab-node /usr/local/bin/iceslab-hyhop \
                 /etc/iceslab-node /etc/fail2ban/jail.d/iceslab.local \
                 /etc/fail2ban/filter.d/iceslab-hysteria.conf "$checkout" \
                 /etc/systemd/system/nginx.service /etc/xray/keys.json \
                 /etc/fail2ban/jail.local /etc/fail2ban/jail.d/sshd-custom.local \
                 /usr/local/bin/some-other-tool; do
            [[ -e "$f" ]] && printf "%s\n" "$f"
        done > "$4"
        exit 0
    ' _ "$BIN" "${WORK}/ufw.log" "${WORK}/uninstall.sh" "$SURVIVORS" >"$UNINST_OUT" 2>&1
}

run_do_uninstall

# ───── Protocol ports left open by the install being removed ─────
#
# They accumulate: a node re-installed from xray to hysteria kept
# `443/tcp ALLOW Anywhere` for a core that is no longer there, and the next
# protocol added its own on top. Observed on a live KVM guest 2026-08-27.
#
# The rule an operator scoped to an address is a DIFFERENT ufw rule and must
# survive — which is why the removal only issues the world-open form.
UFW_LEFTOVERS="1337/tcp                   ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
443/udp                    ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       203.0.113.9"
: > "${WORK}/ufw.log"
FAKE_UFW_STATUS="$UFW_LEFTOVERS" run_do_uninstall

for _p in 443/tcp 443/udp 80/tcp; do
    if grep -qF -- "ufw --force delete allow ${_p}" "${WORK}/ufw.log"; then
        ok "uninstall removes the ${_p} rule it had opened for the protocol"
    else
        bad "left ${_p} open with nothing listening on it:
$(sed 's/^/      /' "${WORK}/ufw.log")"
    fi
done
# The guard that makes the three above mean something: a port ufw does NOT
# report is not deleted blindly. Without the status check this would fire.
if grep -qF -- "ufw --force delete allow 1234/udp" "${WORK}/ufw.log"; then
    bad "deleted a 1234/udp rule that ufw never reported: the removal is not reading the current state"
else
    ok "and touches no port ufw did not report as open"
fi
# `ufw delete allow 443/tcp` names the world-open rule only; the scoped one is
# a separate rule with its own number. Asserted on the argv because the stub
# has no rule table of its own.
if grep -qE -- "ufw --force delete allow 443/tcp from|203\.0\.113\.9" "${WORK}/ufw.log"; then
    bad "the removal reached for an operator's address-scoped rule"
else
    ok "and never names an operator's address-scoped rule"
fi

# Control first: the run has to have happened at all. Its own log lines are the
# cheapest proof, and without them "everything was removed" is also true of a
# function that never ran.
if grep -q 'Removing binary' "$UNINST_OUT" && grep -q 'Removing env directory' "$UNINST_OUT"; then
    ok "do_uninstall ran against a tmpfs copy of every path it touches"
else
    bad "do_uninstall produced no output; every case below is vacuous:
$(sed 's/^/      /' "$UNINST_OUT")"
fi

ours_left=$(grep -E 'iceslab|hysteria/config|xray/config|iceslab-node-src' "$SURVIVORS" | tr '\n' ' ')
if [[ -z "${ours_left// /}" ]]; then
    ok "everything this installer put down is gone"
else
    bad "an uninstall left our own files behind, so a reinstall finds them in place:${ours_left}"
fi

# The direction that bites. `/etc/fail2ban/jail.local` is fail2ban's own
# documented place for local configuration — where an operator's sshd or nginx
# jail lives — and this installer has never written it: the removal and the
# namespaced `jail.d/iceslab.local` it actually writes were added in the same
# commit. The comment two lines above the removal says the opposite intent,
# "leave the fail2ban package installed, it may protect other services".
for f in /etc/fail2ban/jail.local /etc/fail2ban/jail.d/sshd-custom.local \
         /etc/systemd/system/nginx.service /etc/xray/keys.json \
         /usr/local/bin/some-other-tool; do
    if grep -qxF "$f" "$SURVIVORS"; then
        ok "left $f alone"
    else
        bad "$f was removed and this installer never wrote it"
    fi
done

if grep -q "delete allow 1337/tcp" "${WORK}/ufw.log" 2>/dev/null; then
    ok "and withdrew the ufw rule it opened for the agent port"
else
    bad "the ufw allow for the agent port was left open; calls were:
$(sed 's/^/      /' "${WORK}/ufw.log" 2>/dev/null)"
fi

fi   # namespaces available

# ═════════════════════════════════════════════════════════════════════════════
#  The contracts the installers hold with files they never read
# ═════════════════════════════════════════════════════════════════════════════
note "cross-file contracts"

# The pre-pull. `install-iceslab.sh` pulls base images before building so the
# build stages do not compete for bandwidth, and its own comment records what
# happens when a tag drifts: "we once had node:22-alpine vs the Dockerfile's
# 22.22-alpine, and golang:1.23 vs 1.22: both dead pulls". A dead pull is not
# an error — docker fetches an image nobody builds with, the build then pulls
# the real one anyway, and the only symptom is the slow first run the pre-pull
# exists to prevent.
#
# "Nobody builds with" has to mean THIS installer's build, not the repository's.
# The first version of this case read all three Dockerfiles, the agent's
# included, and therefore accepted `golang:1.22-alpine` — an image every panel
# host downloaded on every install and no build on that host ever opened,
# because the only thing that builds the Go agent is CI. The set below is read
# out of docker-compose.prod.yml, which is the file the installer's own
# `docker compose build` is pointed at.
prepulled=$(grep -oE '^docker pull [a-z0-9./-]+:[A-Za-z0-9._-]+' "$PANEL_INSTALLER" | awk '{print $3}' | sort -u)
if [[ -n "$prepulled" ]]; then
    ok "the installer pre-pulls $(printf '%s\n' "$prepulled" | grep -c .) base image(s)"
else
    bad "no \`docker pull\` lines found in ${PANEL_INSTALLER}; this contract is not being checked"
fi

BUILT_DOCKERFILES=$(grep -oE '^\s*dockerfile: [A-Za-z0-9./_-]+' "${REPO_ROOT}/docker-compose.prod.yml" \
    | awk '{print $2}' | sort -u)
unreadable=""
for df in $BUILT_DOCKERFILES; do
    [[ -r "${REPO_ROOT}/${df}" ]] || unreadable="${unreadable} ${df}"
done
if [[ "$(printf '%s\n' "$BUILT_DOCKERFILES" | grep -c .)" -ge 2 && -z "$unreadable" ]]; then
    ok "the prod compose names $(printf '%s\n' "$BUILT_DOCKERFILES" | grep -c .) Dockerfile(s), all readable"
else
    bad "the Dockerfiles read out of docker-compose.prod.yml are not a set this can compare against (unreadable:${unreadable:- none}):
$(printf '        %s\n' $BUILT_DOCKERFILES)"
fi

# What that build and the stack actually use: ARG defaults in the Dockerfiles
# compose builds, plus the images compose names outright.
declared="$(
    {
        for df in $BUILT_DOCKERFILES; do
            # `ARG NODE_VERSION=22.22-alpine` + `FROM node:${NODE_VERSION}` ->
            # node:22.22-alpine. Read as a pair so a renamed ARG cannot pass by
            # matching nothing.
            while read -r arg val; do
                img=$(grep -oE "^FROM [a-z0-9./_-]+:\\\$\{${arg}\}" "${REPO_ROOT}/${df}" | head -1 | sed 's/^FROM //')
                [[ -n "$img" ]] && printf '%s\n' "${img%%:*}:${val}"
            done < <(grep -oE '^ARG [A-Z_]+=[A-Za-z0-9._-]+' "${REPO_ROOT}/${df}" | sed 's/^ARG //' | tr '=' ' ')
        done
        grep -oE '^\s*image: [a-z0-9./-]+:[A-Za-z0-9._-]+' "${REPO_ROOT}/docker-compose.prod.yml" \
            | awk '{print $2}' | grep -v '^iceslab-'
    } | sort -u
)"
if [[ -n "$declared" ]]; then
    ok "they and compose declare $(printf '%s\n' "$declared" | grep -c .) base image(s)"
else
    bad "nothing parsed out of the Dockerfiles or compose; the comparison below would be empty"
fi

dead=$(comm -23 <(printf '%s\n' "$prepulled") <(printf '%s\n' "$declared") | tr '\n' ' ')
if [[ -z "${dead// /}" ]]; then
    ok "every pre-pulled tag is one this host's build or stack actually opens"
else
    bad "the installer pre-pulls tags nothing on the panel host uses (dead pulls, the exact failure its comment describes):${dead}
      declared: $(printf '%s ' $declared)"
fi

# The other direction, which is the one the pre-pull exists for: an image the
# build needs and nobody warmed is fetched mid-build, serially, which is the
# silent first-run delay this step was added to remove.
cold=$(comm -13 <(printf '%s\n' "$prepulled") <(printf '%s\n' "$declared") | tr '\n' ' ')
if [[ -z "${cold// /}" ]]; then
    ok "and every base image the build needs is pre-pulled"
else
    bad "these base images are built with and never pre-pulled:${cold}"
fi

# The node agent's mTLS port is written down three times: the installer's
# NODE_PORT default, the ansible role's iceslab_node_agent_port (whose comment
# says it must match, and whose health check dials it), and DEFAULT_NODE_PORT in
# the panel's three node screens. The frontend side is compared in
# nodeProtocols.mirror.test.ts; this is the deployment side.
shell_port=$(grep -E '^NODE_PORT=' "$NODE_INSTALLER" | head -1 | grep -oE ':-[0-9]+' | grep -oE '[0-9]+')
ansible_port=$(grep -oE '^iceslab_node_agent_port: [0-9]+' \
    "${REPO_ROOT}/deploy/ansible/roles/iceslab_node/defaults/main.yml" | grep -oE '[0-9]+$')
if [[ -n "$shell_port" && -n "$ansible_port" ]]; then
    ok "both the installer ($shell_port) and the ansible role ($ansible_port) name a port"
else
    bad "could not read the port from one of the two sides (installer='$shell_port' ansible='$ansible_port')"
fi
if [[ "$shell_port" == "$ansible_port" ]]; then
    ok "and they are the same port, so the role's health check dials what the installer bound"
else
    bad "the ansible role dials :${ansible_port} and the installer binds :${shell_port}"
fi

# ───── A secret file is 0600 from its first byte, not from its last ─────
#
# `chmod 600 "$FILE"` reads as "this file is private". It is, eventually. A bare
# `cat > "$FILE"` creates it with root's umask, which is 0022 on Debian, so the
# file exists at 0644 for as long as the write takes — and these writes are not
# instant: the panel's heredoc runs `openssl rand` and `date` inside itself, and
# the backup one is a `tar | openssl enc` of the whole database.
#
# Measured rather than argued, in a debian:13 container: `cat > f` leaves 644;
# `install -m 0600 /dev/null f` and then the same redirect leaves 600, because
# the redirect truncates and keeps the mode of a file that is already there.
#
# The chmod stays, and is not redundant: it is what narrows a file some earlier
# install left at 0644. So the rule asked here is that BOTH are present.
note "secret files are created private"
mode_missing=""
mode_checked=0
for f in "$PANEL_INSTALLER" "$NODE_INSTALLER" \
         "${REPO_ROOT}/scripts/ops/iceslab-backup.sh" \
         "${REPO_ROOT}/apps/node/scripts/bootstrap-singbox.sh"
do
    [[ -r "$f" ]] || { mode_missing="${mode_missing} (unreadable: ${f})"; continue; }
    # The list of secret paths is READ from the chmods themselves, so a file
    # added later is covered without anyone remembering this case exists.
    while read -r target; do
        [[ -n "$target" ]] || continue
        # /swapfile holds zeroes at creation time; it is chmodded for the same
        # reason but there is nothing to read out of it in the window.
        [[ "$target" == "/swapfile" ]] && continue
        mode_checked=$((mode_checked + 1))
        grep -qF "install -m 0600 /dev/null ${target}" "$f" \
            || mode_missing="${mode_missing}
        $(basename "$f"): ${target}"
    done < <(grep -oE '^\s*chmod 0?600 ("?\$?[A-Za-z_{}/.-]+"?)' "$f" \
             | grep -oE '("?\$?[A-Za-z_{}/.-]+"?)$')
done
if [[ "$mode_checked" -ge 5 ]]; then
    ok "found $mode_checked secret file(s) the installers chmod to 600"
else
    bad "only $mode_checked chmod-600 targets parsed out; this case is nearly empty"
fi
if [[ -z "${mode_missing// /}" ]]; then
    ok "and every one of them is created 0600 before anything is written into it"
else
    bad "these are written first and narrowed afterwards, so they exist world-readable in between:${mode_missing}"
fi

# ───── The two halves of one sandbox decision ─────
#
# The installer pre-creates every per-protocol config directory, and its own
# comment says why: "ReadWritePaths can't create directories, only permit writes
# inside existing ones". So the mkdir list and the unit's ReadWritePaths list
# are one decision written twice, and the copies are 300 lines apart.
#
# They had diverged. /etc/sing-box was created and not listed, so on every TUIC,
# AnyTLS and ShadowTLS node — and every engine=singbox inbound anywhere — the
# agent's config write died on "read-only file system" while the node still
# reported healthy, because the agent was up and only the core was unconfigured.
# Found 2026-08-27 by asking a running unit what it could write
# (installer-systemd-selftest.sh); this is the same question asked of the source,
# so the next divergence does not need a container to be caught.
note "config dirs the unit must be able to write"
mkdir_line=$(grep -E '^mkdir -p /etc/xray ' "$NODE_INSTALLER" | head -1)
rwp_line=$(grep -E '^ReadWritePaths=' "$NODE_INSTALLER" | head -1)
if [[ -n "$mkdir_line" && -n "$rwp_line" ]]; then
    ok "both lists were found in the installer"
else
    bad "could not read one of the two lists (mkdir='${mkdir_line}' rwp='${rwp_line}')"
fi
# The control: an extraction that silently stopped matching would make the
# comparison below vacuously true, and this is exactly the shape that hid the
# defect in the first place.
if [[ "$(grep -oc '/etc/' <<<"$mkdir_line")" != "0" ]] && grep -q '/etc/iceslab-node' <<<"$rwp_line"; then
    ok "and both name the paths this compares"
else
    bad "one of the two lists came back without paths in it"
fi
missing=""
for d in $(grep -oE '/etc/[a-z0-9/-]+' <<<"$mkdir_line"); do
    grep -qE -- "-${d}( |$)" <<<"$rwp_line" || missing="${missing}
        ${d}"
done
if [[ -z "$missing" ]]; then
    ok "every config dir the installer creates is one the unit may write"
else
    bad "created for the unit to write, and absent from ReadWritePaths — the agent will get EROFS there:${missing}"
fi

# ───── --with-singbox: one condition, written twice ─────
#
# `--with-singbox` puts the sing-box engine on a node whose primary protocol is
# something else, and it is decided in two places 190 lines apart: once to chain
# bootstrap-singbox.sh (installs the binary) and once to append SINGBOX_* to the
# env file (makes the agent register the adapters). Both carry the same
# three-way exclusion for the protocols that ARE sing-box and have installed it
# already.
#
# Drift either way is silent and total. Binary without env: the adapters never
# register, so every engine=singbox inbound the panel pushes is refused by a
# node that has the core sitting on disk. Env without binary: the adapters
# register pointing at a path with nothing at it, and the first inbound fails to
# spawn — on a node that reports healthy until then.
note "--with-singbox is decided the same way in both places"
mapfile -t singbox_conds < <(grep -nE '^\s*if \[ "\$\{WITH_SINGBOX:-0\}" = "1" \]' "$NODE_INSTALLER")
if [[ "${#singbox_conds[@]}" -ge 2 ]]; then
    ok "both copies of the condition were found (lines $(printf '%s ' "${singbox_conds[@]%%:*}"))"
else
    bad "found ${#singbox_conds[@]} copies of the --with-singbox condition, expected 2; the shape changed and this comparison is empty"
fi
uniq_conds=$(printf '%s\n' "${singbox_conds[@]#*:}" | sed 's/^[[:space:]]*//' | sort -u | wc -l)
if [[ "${#singbox_conds[@]}" -ge 2 && "$uniq_conds" -eq 1 ]]; then
    ok "and they are the same condition, so the binary and the env agree on when to appear"
elif [[ "${#singbox_conds[@]}" -ge 2 ]]; then
    bad "the two copies differ, so a node can get the sing-box binary without the env that registers it (or the reverse):
$(printf '        %s\n' "${singbox_conds[@]}")"
fi

# ───── --ssh-port is checked before anything opens a firewall ─────
#
# It decides which port every SSH rule opens AND which port the fail2ban jail
# watches. A value that is not a port makes ufw refuse each rule silently (every
# one of those calls ends in `|| true`) and then `ufw --force enable` comes up
# with no SSH rule at all — the one outcome the whole SSH-first ordering exists
# to prevent. So it is refused by name, early, on any host.
note "--ssh-port"
for bad_port in "twenty-two" "0" "65536" "22 "; do
    run_installer --ssh-port "$bad_port" --protocol xray --payload "$PAYLOAD"
    if [[ "$INST_RC" != "0" ]] && grep -q -- '--ssh-port' "$INST_OUT"; then
        ok "refuses --ssh-port '${bad_port}' and names the flag"
    else
        bad "--ssh-port '${bad_port}' was accepted (rc=$INST_RC):
$(sed 's/^/      /' "$INST_OUT" | head -5)"
    fi
done
# The control: a refusal of everything is not a check. A real port must get
# past this and fail later, on something else entirely.
run_installer --ssh-port 2222 --protocol xray --payload "$PAYLOAD"
if grep -q -- '--ssh-port' "$INST_OUT"; then
    bad "a valid --ssh-port was refused too, so the case above proves nothing"
else
    ok "and lets a real port through"
fi
# An install-only flag must not stand between the operator and --uninstall.
run_installer --ssh-port "not-a-port" --uninstall
if [[ "$INST_RC" == "0" ]] && grep -q 'Nothing to uninstall' "$INST_OUT"; then
    ok "and does not block --uninstall, which writes no firewall rule"
else
    bad "--uninstall was refused over an install-only flag (rc=$INST_RC)"
fi

# ───── The Xray REALITY pre-seed flags, where they cannot take effect ─────
#
# All five reach one place: the env block the `xray` branch writes, and only
# when a private key is there to pre-seed with. Given to any other protocol, or
# without the key, they used to be read, stored and dropped in silence while the
# install went on to report success — the same shape as --xray-reality-public-
# key, which took a value and recorded it nowhere. The refusal happens after the
# protocol is settled and before anything is installed.
note "the Xray REALITY pre-seed flags"
run_installer --protocol hysteria --xray-port 8443 --payload "$PAYLOAD"
if [[ "$INST_RC" != "0" ]] && grep -q -- '--protocol hysteria ignores' "$INST_OUT" \
   && grep -q -- '--xray-port' "$INST_OUT"; then
    ok "a pre-seed flag under a non-xray protocol is refused, and the flag is named"
else
    bad "--xray-port under --protocol hysteria exited $INST_RC:
$(sed 's/^/      /' "$INST_OUT" | head -6)"
fi
run_installer --protocol xray --xray-reality-short-ids abc123 --payload "$PAYLOAD"
if [[ "$INST_RC" != "0" ]] && grep -q 'needs --xray-reality-private-key' "$INST_OUT"; then
    ok "and so is the rest of the pre-seed with no private key to seed from"
else
    bad "--xray-reality-short-ids without a private key exited $INST_RC:
$(sed 's/^/      /' "$INST_OUT" | head -6)"
fi
# The control, in both directions: a refusal of everything is not a check, and
# it must not fire on the two installs that are actually correct.
run_installer --protocol xray --xray-reality-private-key K --xray-port 8443 --payload "$PAYLOAD"
if grep -qE 'ignores|needs --xray-reality-private-key' "$INST_OUT"; then
    bad "a private key plus a port was refused too, so the cases above prove nothing:
$(sed 's/^/      /' "$INST_OUT" | head -6)"
else
    ok "a private key with the rest of the pre-seed gets through"
fi
run_installer --protocol hysteria --payload "$PAYLOAD"
if grep -qE 'ignores|needs --xray-reality-private-key' "$INST_OUT"; then
    bad "a hysteria install with no pre-seed flags at all was refused over them"
else
    ok "and an install that passes none of them is never asked about them"
fi

# ═════════════════════════════════════════════════════════════════════════════
#  install-iceslab.sh: the mode-derived values on a re-run
# ═════════════════════════════════════════════════════════════════════════════
#
# The panel installer's closing message tells the operator how to get TLS:
# "re-run with PANEL_DOMAIN=...". Doing exactly that used to change nothing in
# an existing .env.production, because the whole file is kept ("already exists,
# keeping current secrets") — and three of its values are derived from the MODE,
# not from secrets.
#
# Found by running the installer twice on a live KVM guest:
#   - FRONTEND_BIND stayed 0.0.0.0, so the SPA answered plain HTTP to the whole
#     internet beside the new TLS site. Measured on that guest: `ufw deny
#     8080/tcp` and the page still returned 200 — docker publishes through
#     nat/PREROUTING, which runs before ufw's filter chains, so the firewall has
#     no say. After the fix the socket moved to 127.0.0.1 and the same request
#     got nothing.
#   - PUBLIC_URL and CORS_ORIGIN stayed http://<bare-ip>:8080, so every node
#     bootstrap command, every subscription link and the panelUrl baked into
#     node payloads kept pointing at plain HTTP on a raw address.
#
# The real function is cut out and run here, the same instrument as pinned_fetch
# and do_uninstall.
note "install-iceslab.sh: mode-derived values on a re-run"
RECON="${WORK}/reconcile.sh"
{
    grep -E '^(log|warn|fail)\(\) +\{.*\}$' "$PANEL_INSTALLER"
    sed -n '/^reconcile_mode_values()/,/^}/p' "$PANEL_INSTALLER"
} > "$RECON"
if grep -q '^reconcile_mode_values()' "$RECON" && grep -q 'FRONTEND_BIND' "$RECON"; then
    ok "reconcile_mode_values was cut out of the panel installer"
else
    bad "could not cut reconcile_mode_values out of ${PANEL_INSTALLER}; the cases below would be vacuous"
fi

run_reconcile() {  # $1 = domain (may be empty), rest = env lines
    local domain="$1"; shift
    printf '%s\n' "$@" > "${WORK}/envfile"
    ( set +u
      # shellcheck disable=SC1090
      source "$RECON"
      PUBLIC_URL="${OVERRIDE_PUBLIC_URL:-}" CORS_ORIGIN="${OVERRIDE_CORS:-}" \
      FRONTEND_BIND="${OVERRIDE_BIND:-}" \
        reconcile_mode_values "${WORK}/envfile" "$domain" 8080
    ) > "${WORK}/recon.out" 2>&1
}

BARE=(
  'PUBLIC_URL=http://203.0.113.9:8080'
  'CORS_ORIGIN=http://203.0.113.9:8080'
  'FRONTEND_BIND=0.0.0.0'
  'JWT_SECRET=keep-me'
)

run_reconcile "panel.example.com" "${BARE[@]}"
if grep -q '^FRONTEND_BIND=127.0.0.1$' "${WORK}/envfile"; then
    ok "switching to domain mode closes the SPA port ufw cannot close"
else
    bad "FRONTEND_BIND was left at $(sed -n 's/^FRONTEND_BIND=//p' "${WORK}/envfile"): the panel stays on the internet in plain HTTP"
fi
if grep -q '^PUBLIC_URL=https://panel.example.com$' "${WORK}/envfile" \
   && grep -q '^CORS_ORIGIN=https://panel.example.com$' "${WORK}/envfile"; then
    ok "and the URLs the panel hands out follow the mode"
else
    bad "PUBLIC_URL/CORS_ORIGIN still point at the bare IP:
$(sed 's/^/      /' "${WORK}/envfile")"
fi
if grep -q '^JWT_SECRET=keep-me$' "${WORK}/envfile"; then
    ok "and the secrets are untouched, which is the whole reason the file is kept"
else
    bad "the reconciliation rewrote a secret"
fi
if grep -q 'ufw cannot close' "${WORK}/recon.out"; then
    ok "and it says why, rather than moving an operator's value in silence"
else
    bad "changed FRONTEND_BIND without explaining it"
fi

# An operator's own origin is not ours to correct: only the exact shape this
# script writes in bare-IP mode is.
run_reconcile "panel.example.com" 'PUBLIC_URL=https://vpn.corp.example/panel' 'CORS_ORIGIN=https://vpn.corp.example' 'FRONTEND_BIND=127.0.0.1'
if grep -q '^PUBLIC_URL=https://vpn.corp.example/panel$' "${WORK}/envfile"; then
    ok "a custom PUBLIC_URL is left alone"
else
    bad "overwrote an operator's own PUBLIC_URL"
fi

# An explicit environment value wins over the derived one.
OVERRIDE_PUBLIC_URL="https://alt.example.com" run_reconcile "panel.example.com" "${BARE[@]}"
if grep -q '^PUBLIC_URL=https://alt.example.com$' "${WORK}/envfile"; then
    ok "an explicit PUBLIC_URL beats the domain-derived one"
else
    bad "ignored an explicit PUBLIC_URL"
fi

# The other direction must never OPEN a port on an inference.
run_reconcile "" 'PUBLIC_URL=https://panel.example.com' 'CORS_ORIGIN=https://panel.example.com' 'FRONTEND_BIND=127.0.0.1'
if grep -q '^FRONTEND_BIND=127.0.0.1$' "${WORK}/envfile"; then
    ok "dropping the domain does NOT publish the SPA port by itself"
else
    bad "opened the SPA port to the world on an inference"
fi
if grep -q 'will not be reachable directly' "${WORK}/recon.out"; then
    ok "and says the SPA is now unreachable, which is the surprising half"
else
    bad "left the operator to discover the unreachable SPA themselves"
fi

# ───── The ansible role's "one-to-one" claim, checked ─────
#
# The role's defaults say its knobs "mirror install-iceslab-node.sh's own flags
# one-to-one: the role runs that script rather than reimplementing it". That is
# a claim about the OTHER artefact, and this repo has been bitten by exactly
# that shape before — a comment naming a flag (`--dry-pin`) that never existed.
# A flag the role passes and the parser does not know makes every
# ansible-managed install die on "Unknown arg"; the reverse leaves a capability
# reachable by hand and not by the role.
# ═════════════════════════════════════════════════════════════════════════════
#  Cores come from the panel, and the refusal path is the point
# ═════════════════════════════════════════════════════════════════════════════
#
# `panel_core_fetch` is the function that replaced "download the core from
# GitHub and install it". Everything it has to get right is a refusal: no
# panelUrl in the payload, no bearer, a panel that answers 404 for an
# architecture it was not built with, and — the one that matters most — bytes
# whose sha256 does not match what the panel pinned. None of those may end with
# a binary on disk.
#
# Cut out of the installer the same way `pinned_fetch` is, so the body under
# test is the shipped one.
note "panel_core_fetch"

# A payload is base64 of the JSON the panel mints. These build one by hand so
# the cases can leave a field out.
mk_payload() {
    printf '%s' "$1" | base64 -w0
}
FULL_PAYLOAD="$(mk_payload '{"nodeCertPem":"x","heartbeatToken":"tok-abc","panelUrl":"https://panel.example"}')"

OUT="$(PAYLOAD="$(mk_payload '{"nodeCertPem":"x"}')" CORE_ARCH=amd64 bash -c '
    source "$1"; panel_core_fetch xray /tmp/no-such-dest' _ "$CORE_FUNCS" 2>&1 || true)"
if grep -q 'no panelUrl' <<<"$OUT"; then
    ok "a payload with no panelUrl refuses and says which field is missing"
else
    bad "a payload with no panelUrl said: ${OUT}"
fi

OUT="$(PAYLOAD="$(mk_payload '{"panelUrl":"https://panel.example"}')" CORE_ARCH=amd64 bash -c '
    source "$1"; panel_core_fetch xray /tmp/no-such-dest' _ "$CORE_FUNCS" 2>&1 || true)"
if grep -q 'heartbeatToken' <<<"$OUT"; then
    ok "and a payload with no bearer names that instead"
else
    bad "a payload with no heartbeatToken said: ${OUT}"
fi

OUT="$(PAYLOAD="$FULL_PAYLOAD" CORE_ARCH="" bash -c '
    source "$1"; panel_core_fetch xray /tmp/no-such-dest' _ "$CORE_FUNCS" 2>&1 || true)"
if grep -q 'unsupported architecture' <<<"$OUT"; then
    ok "and an architecture this script cannot name refuses before any request"
else
    bad "an unmapped architecture said: ${OUT}"
fi

# The two fields are read out of a real base64 payload, so a change to the
# reader is caught here rather than on a node.
OUT="$(PAYLOAD="$FULL_PAYLOAD" bash -c 'source "$1"; payload_field heartbeatToken' _ "$CORE_FUNCS")"
if [[ "$OUT" == "tok-abc" ]]; then
    ok "payload_field reads a value out of the base64 payload"
else
    bad "payload_field returned [${OUT}], expected tok-abc"
fi

note "the ansible role passes only flags the installer knows"
ROLE_TASK="${REPO_ROOT}/deploy/ansible/roles/iceslab_node/tasks/agent.yml"
if [[ -r "$ROLE_TASK" ]]; then
    mapfile -t role_flags < <(grep -oE -- '--[a-z][a-z0-9-]+' "$ROLE_TASK" | tr -d ' ' | sort -u)
    mapfile -t parser_flags < <(grep -oE '^[[:space:]]+--[a-z][a-z0-9-]+\)' "$NODE_INSTALLER" | tr -d ' )' | sort -u)
    if [[ "${#role_flags[@]}" -ge 4 && "${#parser_flags[@]}" -ge 10 ]]; then
        ok "read ${#role_flags[@]} flag(s) from the role and ${#parser_flags[@]} from the parser"
    else
        bad "one of the two extractions came back nearly empty (role=${#role_flags[@]} parser=${#parser_flags[@]}); this comparison would be vacuous"
    fi
    unknown=""
    for f in "${role_flags[@]}"; do
        printf '%s\n' "${parser_flags[@]}" | grep -qx -- "$f" || unknown="${unknown} ${f}"
    done
    if [[ -z "$unknown" ]]; then
        ok "every flag the role passes is one the installer parses"
    else
        bad "the role passes flags the installer would refuse by name:${unknown}"
    fi
else
    bad "the ansible role's agent.yml is not readable; the one-to-one claim cannot be checked"
fi

echo
if [[ $FAIL -eq 0 ]]; then
    printf '\033[1;32m%d/%d check(s) passed\033[0m\n' "$PASS" "$((PASS + FAIL))"
    exit 0
fi
printf '\033[1;31m%d/%d check(s) passed, %d failed\033[0m\n' "$PASS" "$((PASS + FAIL))" "$FAIL"
exit 1
