# Node provisioning with Ansible

The role `iceslab_node` installs a node by running the panel's own node
installer (`scripts/install-iceslab-node.sh`) with the values you set, so a node
installed from an inventory is the same node as one installed by pasting the
panel's "Create node" command. Everything the installer does stays the
installer's: packages, kernel tuning, the agent, every core through its
`bootstrap-<core>.sh`.

## Usage

```sh
cd deploy/ansible
cp inventory.example.ini inventory.ini   # your nodes, key-based SSH only
ansible-playbook site.yml --limit node-01
```

Requires `ansible-core` 2.16 or later on the control machine, builtins only. To
check the role without touching a node:

```sh
ansible-playbook --syntax-check site.yml -i inventory.example.ini
```

### Inventory

One host per node. **The host name in the inventory must be the node's name in
the panel** (a later automatic run by the panel finds the host by that name);
`ansible_host` is its address. A host whose sshd is not on port 22 needs
`ansible_port` and `iceslab_ssh_port` set to the same number.

### Variables

Required, the play stops before any change on the node without them:

| Variable | What |
|---|---|
| `iceslab_panel_url` | the panel, e.g. `https://panel.example.com` |
| `iceslab_node_repo`, `iceslab_node_ref` | the agent's source; no default, so a node is never built from a release nobody chose |
| `iceslab_bootstrap_token` | the node's single-use token, needed only while the node is not installed yet |

Optional, each the installer flag of the same name:

| Variable | Flag |
|---|---|
| `iceslab_engines` (list) | `--engines` |
| `iceslab_harden_ufw`, `iceslab_ssh_allowlist` | `--harden-ufw`, `--ssh-allowlist` (an allowlist without your own address locks you out) |
| `iceslab_fail2ban` | `--fail2ban` |
| `iceslab_ssh_port` | `--ssh-port`, passed when it is not 22 (must be the port sshd listens on) |
| `iceslab_node_agent_port` | `--port`, passed when it is not 1337; the play waits for it |
| `iceslab_node_ref_sha` | `ICESLAB_NODE_REF_SHA`, the commit the ref must resolve to |
| `iceslab_installer_handover` | `ICESLAB_HANDOVER` |
| `iceslab_installer_extra_args` (list) | anything else, as the installer takes it, e.g. `["--panel-ip", "203.0.113.5"]` |

The installer copy that goes to the node is the one in this repository. Asked for
a ref other than its own, the installer replaces itself with that ref's copy from
`raw.githubusercontent.com`, and stops when the repository is not on GitHub. Set
`iceslab_installer_handover` (any non-empty value, e.g. `off`) when the
repository is not on GitHub, or when the checkout you run the role from is
already the revision of `iceslab_node_ref`; otherwise the steps that run on the
node are not the ones in this repository.

The token goes to the installer as a 0600 file (`--bootstrap-file`), not on the
command line, and is removed afterwards, whether the install worked or not.
`--bootstrap-file` works with an https panel; a panel on plain http gives no
token, only a payload file, which this role does not handle.

### Runs once

The install runs once per node: `/etc/iceslab-node/env` marks it done, and a run
on an installed node changes nothing. A variable changed afterwards (cores, ports,
hardening, SSH port) is not applied by the role: cores change from the node page,
the rest by installing again by hand (`--reset` of the installer).

The play ends by checking that the agent listens on its port and its unit is
active. It does not call the agent: that needs the panel's client certificate.

## Bringing in a spare node by hand

1. In the panel, create the node (or take the spare you made earlier) with the
   status `disabled`, named as its host in the inventory.
2. Mint a token for it: `POST /api/nodes/<id>/bootstrap` (bearer of an admin); the
   answer's `token` is the value for `iceslab_bootstrap_token`. **It lives 15
   minutes and works once**: mint it right before the run, and mint a new one if
   the run failed or was slow (building the agent and downloading the cores on a
   small VPS can take a while).
3. Run the role against that host only, with the token as an extra variable (not
   written to the inventory file):
   ```sh
   ansible-playbook site.yml --limit spare-01 -e iceslab_bootstrap_token=bs_xxx
   ```
4. When the play ends, switch the node from `disabled` to `active` in the panel.

## Host keys

`ansible.cfg` sets `host_key_checking = False`: a spare is a fresh VPS whose host
key is not known in advance. The price is that a changed or forged key is not
noticed. Put the keys in `known_hosts` and remove the line if you know them.
