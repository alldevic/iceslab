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

## The cold pool of spares

With `EXT_VPTECH_POOL_ENABLED=true` the panel replaces a node whose traffic has
vanished (`node.anomaly`, not cleared by `node.anomaly-cleared` within 5 minutes,
severity critical) with a spare. This is the pool's half of the picture; what
the panel does today:

- picks a spare: a node with status `disabled` and the label `spare`, not `burned`,
  preferring another autonomous system, then another provider, then the same
  country;
- issues a bootstrap token for it and **installs the spare with this role** when
  `EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK` is set (next section); without it the step is
  one log line and nothing is installed, and the spare then shows as `unreachable`
  after the next status poll until you install it by hand (the token lives 15
  minutes, mint another);
- takes the spare out of `disabled` and removes its `spare` label; carries the
  burned node's bindings and node policy to it;
- sets the burned node `disabled` with `burned`, so it is never picked again.

A failed or timed-out install aborts the swap before anything else: the spare
stays `disabled` and keeps its label, the burned node stays in service, and the
operator gets the notice. Nothing retries it by itself, and a failed swap sets no
cooldown: the next `node.anomaly` for that node opens a new incident, confirmed
after 5 minutes as usual, and the new attempt (the spare is picked again, it still has
its label) mints a new token.

### Installing a spare from the panel

The panel runs `ansible-playbook` on its own host, so it needs ansible, the
playbook, an inventory and an SSH key that is root on every spare. The ordinary
backend image has none of these and is unchanged. In docker, use the opt-in
`docker-compose.pool.yml` (image `apps/panel-backend/Dockerfile.ansible`: the
backend image plus `ansible-core` 2.17.7, an SSH client and this directory; the key
and the inventory are read-only mounts):

1. Next to `docker-compose.prod.yml` create `pool/inventory.ini` (the format above:
   one host per spare, the host name = the node's name in the panel, `ansible_host`,
   `ansible_user`, `ansible_ssh_private_key_file=/run/pool/ssh_key`,
   `iceslab_panel_url`, `iceslab_node_repo`, `iceslab_node_ref`, and `iceslab_engines`
   when the spare must carry cores) and `pool/ssh_key` (the private key, `chown 1000:1000`,
   `chmod 600`: the backend runs as uid 1000). **Whoever can read this key is root on
   every spare**: keep it out of backups and repositories. `POOL_SSH_KEY_FILE` and
   `POOL_INVENTORY_FILE` in `.env.production` move them.
2. In `.env.production` set `EXT_VPTECH_POOL_ENABLED=true`. The paths of the playbook
   and the inventory are set by the compose file; set `EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK`
   yourself only for another layout (a panel outside docker: its own paths and
   `EXT_VPTECH_POOL_ANSIBLE_BIN`).
3. Build and start (every later `up` and update needs both `-f`; `scripts/ops/deploy.sh`
   knows only the first file):
   ```sh
   docker compose -f docker-compose.prod.yml build migrate
   docker compose -f docker-compose.prod.yml -f docker-compose.pool.yml --env-file .env.production up -d --build backend
   ```
4. Create each spare in the panel as in "Bringing in a spare node by hand" (status
   `disabled`, the labels below), with its cores in `intendedEngines`.

What the panel hands the run: `--limit <node name>`, `-i <inventory>` and `-e @<file>`,
a 0600 file in a 0700 temporary directory that holds `iceslab_panel_url` (from
`PUBLIC_URL`), the one-time `iceslab_bootstrap_token` and, when the spare's
`intendedEngines` is not empty, `iceslab_engines`. The file is deleted whatever the
outcome. The token is not in the arguments (so not in the process list of the panel
host), not in the panel's log, and not in the text of an error: the file's
content and the token are cut out of what the run says before it is logged. On
the spare the role hands it to the installer the same way (see above).
The run stops after 10 minutes (the token lives 15).

- **The cores of the spare come from the inventory or from `intendedEngines`.**
  The panel does not work them out from the burned node. The bindings the swap
  carries are put through the same checks as on the node page, so a binding of a
  core the spare does not have is skipped and named in the notice: give the spare
  the cores of the profiles of the working nodes.
- **The node name must be a plain host name** (letters, digits, `.`, `-`, `_`): it
  is an `--limit` pattern, and a name such as `all`, `web*` or `a:b` would reach other
  hosts. Such a name makes the swap fail before ansible starts. A name with no host of
  that name in the inventory makes `ansible-playbook` exit 1 ("leaves us with no hosts
  to target"), which is a failed install, not a successful one. A host must not have
  the name of a group of the inventory either.
- The play runs inside the handler of the controller: while an install lasts
  (minutes), the replacement of another node waits.
- The carried bindings are put on the spare right after the install, before the
  agent's first report of its cores; if a binding is refused for that reason, the
  notice says so and it is added by hand.

The labels live in `hardening.pool` of the node and have no screen; set them with
the API (bearer of an admin):

```sh
curl -X PUT https://panel.example.com/api/nodes/<id> -H 'Authorization: Bearer ...' \
  -H 'Content-Type: application/json' \
  -d '{"status":"disabled","hardening":{"pool":{"spare":true,"asn":"AS24940","provider":"hetzner"}}}'
```

`asn` and `provider` are free text, compared as written; give them to the working
nodes as well. A `PUT` whose `hardening` does not name `pool` keeps the labels
(a `hardening` of `null` too); one that names it replaces all of them, so send
`spare`, `asn` and `provider` together. `burned` is set by the panel, and a node
that has it is out of the pool until you send `pool` again without it.

## Host keys

`ansible.cfg` sets `host_key_checking = False`, and the panel starts its run with
`ANSIBLE_HOST_KEY_CHECKING=False`: a spare is a fresh VPS whose host key is not known
in advance. The price is that a changed or forged key is not noticed, and that a
man in the middle on the way to a spare receives the one-time token. Put the keys in
`known_hosts` and remove the line if you know them (for the panel's run the
environment variable is set in `pool.service.ts`).
