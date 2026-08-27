#!/usr/bin/env bash
# Stubs for the parts of install-iceslab-node.sh that must NOT run here, laid
# down inside the throwaway container before the installer is invoked.
#
# What is stubbed and why:
#
#   git, go   The installer clones github.com/icecompany-tech/iceslab at tag
#             v0.2.0 — UPSTREAM, not this fork's three hundred commits — and
#             compiles it. Running that for real would measure somebody else's
#             code and hold the machine for minutes. The stubs produce the two
#             artefacts the later steps actually depend on: a checkout with the
#             bootstrap scripts in it, and an executable at the path the unit's
#             ExecStart names.
#   apt-get   Package installation is not what this harness is about, and the
#             apt-lock hygiene around it already has its own cases in
#             installer-selftest.sh.
#   ufw       There is no meaningful netfilter here, and every ufw call in the
#             installer ends in `>/dev/null 2>&1 || true` — so the ONLY place
#             the firewall decisions are observable at all is the argv. Recorded.
#   curl      Only reached for the public-IP lookup once the install is done.
#   tc        Needs a real qdisc; the installer already tolerates its absence.
#
# Everything else — the unit file, the env file, the sysctl drop-in, the
# journald cap, daemon-reload/enable/restart and the readiness wait — is the
# real thing running against the real systemd in this container.
set -euo pipefail

STUB_BIN=/opt/ice-stub/bin
LOG_DIR=/opt/ice-stub/log
mkdir -p "$STUB_BIN" "$LOG_DIR" /usr/local/go/bin

# /etc/ufw is created by the ufw PACKAGE, which the real installer apt-installs
# and this harness stubs. Standing in for the package here keeps the sandbox
# probe honest: on a real node the directory is there by the time the unit
# starts, so a read-only /etc/ufw would be a harness artefact, not a finding.
mkdir -p /etc/ufw

# The fake agent. It is what `go build -o /usr/local/bin/iceslab-node` produces,
# so systemd starts THIS under the unit the installer wrote — which is the only
# way the unit's own properties can be observed rather than read.
cat > /opt/ice-stub/agent.sh <<'AGENT'
#!/bin/sh
# Probe what ProtectSystem=strict + ReadWritePaths actually permit, from inside
# the unit. The ReadWritePaths list in the installer grew one entry at a time,
# each after a live incident ("caught live on a production node"), and no test
# has ever been inside the sandbox to check that the list still holds.
for d in /etc/iceslab-node /etc/xray /etc/sing-box /etc/hysteria /etc/caddy /etc/mtg /etc/mita /etc/wireguard /etc/amnezia/amneziawg /etc/ufw /var/lib/iceslab-node; do
    if ( : > "$d/.rw-probe" ) 2>/dev/null; then
        echo "PROBE rw $d"
        rm -f "$d/.rw-probe"
    else
        echo "PROBE ro $d"
    fi
done
# And the other direction: a path NOT on the list must be refused, or
# ProtectSystem=strict is decorative.
if ( : > /etc/.rw-probe ) 2>/dev/null; then
    echo "PROBE rw /etc"
    rm -f /etc/.rw-probe
else
    echo "PROBE ro /etc"
fi
echo "AGENT up mode=$(cat /etc/iceslab-node/agent-mode 2>/dev/null || echo idle)"
case "$(cat /etc/iceslab-node/agent-mode 2>/dev/null || echo idle)" in
    exit42) echo "AGENT self-destruct"; exit 42 ;;
    crash)  echo "AGENT crashing";      exit 7  ;;
    *)      while :; do sleep 3600; done ;;
esac
AGENT
chmod +x /opt/ice-stub/agent.sh

cat > "${STUB_BIN}/apt-get" <<'STUB'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> /opt/ice-stub/log/apt.log
exit 0
STUB

cat > "${STUB_BIN}/git" <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> /opt/ice-stub/log/git.log
args=("$@")
if [[ "${args[0]}" == "clone" ]]; then
    dir="${args[-1]}"
    mkdir -p "$dir/.git" "$dir/apps/node/scripts"
    # bootstrap-singbox.sh is what --protocol tuic chains into. The real one
    # downloads sing-box; here it just has to exist and succeed, because what
    # is under test is the eight steps around it.
    cat > "$dir/apps/node/scripts/bootstrap-singbox.sh" <<'BOOT'
#!/usr/bin/env bash
echo "stub bootstrap-singbox"
install -d /usr/local/bin && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/sing-box
chmod +x /usr/local/bin/sing-box
BOOT
    chmod +x "$dir/apps/node/scripts/bootstrap-singbox.sh"
    exit 0
fi
case " $* " in
    *" rev-parse HEAD "*) echo "0000000000000000000000000000000000000000"; exit 0 ;;
esac
exit 0
STUB

cat > /usr/local/go/bin/go <<'STUB'
#!/usr/bin/env bash
printf 'go %s\n' "$*" >> /opt/ice-stub/log/go.log
if [[ "${1:-}" == "version" ]]; then
    echo "go version go1.23.4 linux/amd64"
    exit 0
fi
if [[ "${1:-}" == "build" ]]; then
    out=""; prev=""
    for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
    [[ -n "$out" ]] || { echo "go stub: build with no -o" >&2; exit 2; }
    cp /opt/ice-stub/agent.sh "$out"
    chmod +x "$out"
    exit 0
fi
exit 0
STUB
printf '#!/bin/sh\nexit 0\n' > /usr/local/go/bin/gofmt

cat > "${STUB_BIN}/ufw" <<'STUB'
#!/usr/bin/env bash
printf 'ufw %s\n' "$*" >> /opt/ice-stub/log/ufw.log
exit 0
STUB

# curl is reached for two things now: fetching a proxy core FROM THE PANEL
# (`panel_core_fetch`, every protocol whose core the panel carries) and the
# public-IP lookup at the end.
#
# The core branch has to behave like the panel does, because the installer
# checks what it got: bytes to `-o`, a `x-iceslab-sha256` header into the `-D`
# dump that MATCHES those bytes, and the status code on stdout for `-w`. A stub
# that skipped the header would make the installer refuse — correctly — and the
# harness would look like a defect in the installer.
cat > "${STUB_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> /opt/ice-stub/log/curl.log
out=""; dump=""; url=""; prev=""
for a in "$@"; do
    [[ "$prev" == "-o" ]] && out="$a"
    [[ "$prev" == "-D" ]] && dump="$a"
    [[ "$a" == http*://* ]] && url="$a"
    prev="$a"
done

if [[ "$url" == */api/internal/cores/* ]]; then
    core="${url##*/api/internal/cores/}"; core="${core%%/*}"
    case "$core" in
      xray)
        # A zip the installer can unzip, carrying the three files the real
        # release carries. Built here rather than checked in so the harness
        # needs no fixture binary.
        tmp="$(mktemp -d)"
        printf '#!/bin/sh\nexit 0\n' > "$tmp/xray"; chmod +x "$tmp/xray"
        : > "$tmp/geoip.dat"; : > "$tmp/geosite.dat"
        (cd "$tmp" && zip -q -r /tmp/core.zip xray geoip.dat geosite.dat) 2>/dev/null \
          || (cd "$tmp" && tar -cf /tmp/core.zip .)
        cp /tmp/core.zip "$out"; rm -rf "$tmp" ;;
      sing-box|mtg)
        tmp="$(mktemp -d)"
        printf '#!/bin/sh\nexit 0\n' > "$tmp/$core"; chmod +x "$tmp/$core"
        tar -czf "$out" -C "$tmp" "$core"; rm -rf "$tmp" ;;
      *)
        printf '#!/bin/sh\nexit 0\n' > "$out"; chmod +x "$out" ;;
    esac
    if [[ -n "$dump" ]]; then
        {
          printf 'HTTP/1.1 200 OK\r\n'
          printf 'x-iceslab-sha256: %s\r\n' "$(sha256sum "$out" | awk '{print $1}')"
          printf 'x-iceslab-core-version: 0.0.0-stub\r\n\r\n'
        } > "$dump"
    fi
    printf '200'
    exit 0
fi

if [[ -n "$out" ]]; then
    : > "$out"
fi
echo "203.0.113.9"
exit 0
STUB

cat > "${STUB_BIN}/tc" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

chmod +x "${STUB_BIN}"/* /usr/local/go/bin/go /usr/local/go/bin/gofmt
: > /opt/ice-stub/log/apt.log
: > /opt/ice-stub/log/git.log
: > /opt/ice-stub/log/go.log
: > /opt/ice-stub/log/ufw.log
: > /opt/ice-stub/log/curl.log
echo "stubs installed"
