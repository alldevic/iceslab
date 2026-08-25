# iceslab node provisioning (U6)

Ansible role `iceslab_node` provisions an iceslab VPN node. Idempotent;
every fork-feature step is **off by default**, so a base run just installs a
pinned, post-quantum-capable xray plus BBR.

## What it does

| Task | Default | Notes |
|------|---------|-------|
| `system` | on | base packages + BBR sysctl (the agent's `direct` outbound uses `tcpCongestion=bbr`) |
| `xray` | on | pinned xray (`iceslab_xray_version`, ≥26.x → ML-DSA-65 / ML-KEM-768 keygen) + geodata; downloads with retry (GitHub's release CDN is flaky from some hosts) |
| `zapret2` | **off** (`iceslab_zapret2_enabled`) | B2 ss-zapret2 docker stack |
| `agent` | **off** (needs `iceslab_panel_url` + `iceslab_bootstrap_token`, and `iceslab_node_repo` + `iceslab_node_ref`) | node-agent via the bootstrap-token installer |

## Usage

```bash
cd deploy/ansible
cp inventory.example.ini inventory.ini   # fill in your nodes (key auth only)
ansible-playbook site.yml                # base: xray + BBR
# add fork features per host via inventory/host_vars:
#   iceslab_zapret2_enabled=true   iceslab_panel_url=…  iceslab_bootstrap_token=…
#   iceslab_node_repo=…            iceslab_node_ref=…
```

Installing the agent needs `iceslab_node_repo` + `iceslab_node_ref` as well, and
the play refuses to run without them. The installer takes its source from the
environment and defaults to UPSTREAM `github.com/icecompany-tech/iceslab` at
`v0.2.0`; a fork that leaves them unset provisions nodes running an agent
without any of its own features, and finds out weeks later when a panel call
answers 404 on a node that is otherwise healthy.

Run a subset with tags: `--tags xray`, `--tags zapret2`, `--tags system`.

## B2 zapret2 — socks-via-container

ss-zapret2 desyncs **its own proxied egress** (nfqws runs in the proxy's
network namespace), so you route the destinations you want desynced **into**
its SOCKS, not the host's outbound. Wiring:

1. Set `iceslab_zapret2_enabled=true` → the role runs the docker stack
   (SOCKS on `127.0.0.1:1080`). The panel's `/applyEgress` then manages the
   strategy `config` (it overwrites the seeded one) + lifecycle.
2. On the xray profile, add a **B1 routingFragments** rule routing the
   blocked set into a socks outbound at `127.0.0.1:1080` — the panel helper
   `zapret2RoutingFragments([...])` builds exactly this (see
   `apps/panel-backend/src/modules/egress/egress.routing.ts`).

So: `geosite:blocked → ss-zapret2 socks → desynced egress`; everything else
stays `direct`.

## Status

`system` / `xray` / `zapret2` are verified idempotent against a real node
(Debian 13). `agent` wraps the validated `scripts/install-iceslab-node.sh`
but is **not yet exercised end-to-end** — it needs a panel reachable from
the node (bootstrap-token flow). That step lands when a panel is deployed.

Requires `ansible-core` ≥ 2.16 (uses only builtins — no extra collections).
