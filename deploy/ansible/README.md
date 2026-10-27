# Node provisioning with Ansible

The role `iceslab_node` installs a node by running the panel's own node
installer (`scripts/install-iceslab-node.sh`) with the values you set, so a
node installed from an inventory is the same node as one installed by pasting
the panel's "Create node" command. Everything the installer does stays the
installer's: packages, kernel tuning, the agent, every core through its
`bootstrap-<core>.sh` at the version `packages/shared/src/core-versions.ts`
pins.

The installer shipped to the node hands over to the installer of the ref you
name before it does anything, so the steps that run are always that ref's.

## Usage

```sh
cd deploy/ansible
cp inventory.example.ini inventory.ini   # your nodes, key-based SSH only
ansible-playbook site.yml
```

Required, the play stops without them:

| Variable | What |
|---|---|
| `iceslab_panel_url` | the panel, e.g. `https://panel.example.com` |
| `iceslab_bootstrap_token` | the node's single-use token from "Create node" (15 minutes); usually per host |
| `iceslab_node_repo`, `iceslab_node_ref` | the agent's source; no default, so a node is never built from a release nobody chose |

Optional, each the installer flag of the same name:

| Variable | Flag |
|---|---|
| `iceslab_engines` (list) | `--engines` |
| `iceslab_hysteria_domain`, `iceslab_hysteria_email` | `--hysteria-domain`, `--hysteria-email` |
| `iceslab_hysteria_port_range` | `--hysteria-port-range` (`""` turns hopping off) |
| `iceslab_panel_ip` | `--panel-ip` |
| `iceslab_harden_ufw`, `iceslab_ssh_allowlist` | `--harden-ufw`, `--ssh-allowlist` (an allowlist without your own address locks you out) |
| `iceslab_fail2ban` | `--fail2ban` |
| `iceslab_node_ref_sha` | `ICESLAB_NODE_REF_SHA`, the commit the ref must resolve to |
| `iceslab_installer_extra_args` (list) | anything else, as the installer takes it |

The token goes to the installer as a 0600 file (`--bootstrap-file`), not on
the command line, and is removed afterwards. The install runs once per node
(`/etc/iceslab-node/env` marks it done); to change a node's cores afterwards
use the node page, which runs the same bootstraps.

The play ends by checking that the agent listens on its port and its unit is
active. It does not call the agent: that needs the panel's client certificate.

Requires `ansible-core` 2.16 or later, builtins only.
