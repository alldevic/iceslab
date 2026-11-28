# Moving an installation of the old fork to this fork

English | [Русский](migrate-from-fork.ru.md)

**One-off.** For operators who run the OLD fork (`origin/feat/fork-integration`,
commit `040410ac`) and want this fork with their data. Not for updating this
fork (that is `scripts/ops/deploy.sh`), and not for other commits of the old fork.

What stays: users, their subscription links, keys and `numeric_id`s, squads,
profiles, bindings, hosts, cascades, panel settings, presets, response rules,
traffic history, the admin account and its 2FA, API tokens, the node trust
(CA and certificates). Nodes stay in the panel; their agents are reinstalled
(below). What does not stay is named in "What is lost".

## Before you start

- The old panel is **exactly** at `040410ac`. Another commit: update the old
  fork to `040410ac` with its own deploy first. The pre-check decides by the
  database (migration journal of 65 names, schema equal to the old fork's) and
  refuses anything else with a sentence saying so.
- Free space on the Postgres volume of at least twice the database (the copy),
  plus room for the backups in `<panel>/backups`.
- A window of downtime for the panel (copy, 54 migrations, transforms:
  seconds to a few minutes for a normal panel). Nodes keep their config and
  users stay connected meanwhile.
- `JWT_SECRET` in `.env.production` is **not changed**: it signs sessions and
  seeds the entry nodes subscribers were given.
- Read "What is lost", especially for profiles that use post-quantum REALITY or
  VLESS Encryption fields or `abusePolicy`.

## Order

On the panel host, beside the old installation (here `/opt/iceslab`):

```bash
git clone --branch omega https://github.com/alldevic/iceslab.git /opt/iceslab-new
cd /opt/iceslab-new
scripts/ops/migrate-from-fork.sh --check --panel-dir /opt/iceslab    # reads, writes a report, changes nothing
scripts/ops/migrate-from-fork.sh --run   --panel-dir /opt/iceslab    # the move
```

(`--repo` and `--ref` say what the installation's `origin` and branch become;
the defaults are this fork's repository and `omega`. The menu entry is
`scripts/iceslab.sh migrate-from-fork --check`.)

`--check` builds the image of this fork, runs the pre-check inside it and writes
`<panel>/backups/fork-migration/pre-check-<time>.json` with `blocking`,
`warnings` and `info`. `--run` does the same first and stops on any `blocking`.
Then:

1. backup of the old database (`iceslab-backup.sh`), old images tagged `:pre-fork`;
2. backend and frontend stopped (Postgres and Redis stay);
3. **on a copy of the database** (`<db>_migrating`): the 7 migrations of this
   fork whose effect the old database already has are marked applied, the 15
   names only the old fork has leave the journal, `prisma migrate deploy` applies
   the other 48 + 6, then the transforms below, then the verification (the
   schema equals this fork's, the journal is exactly this fork's, no row of a
   common table is lost, the checksums of secrets are equal);
4. `TRUST_PROXY_HOPS` is written into `.env.production` with the value the old
   panel ran with (the default here is 2, the old one was 1, and a wrong value
   is a security problem), a backup of the copy;
5. Redis is flushed (queues and counters only; nothing of yours is in it);
6. the databases are renamed: the old one stays as `<db>_pre_fork`; the
   checkout's `origin` and branch are switched, images built, stack up, `/health` awaited.

The report is `migrate-from-fork-<time>.json`. Then reinstall the agent of
**every node** right away (below).

## What the transforms do

| Step | What |
|---|---|
| hardening-strip | removes `zapret2`, `bridgeNonXrayInbounds`, `egressPolicy` from `nodes.hardening` (the strict schema of this fork answers 400 otherwise); values go to the report |
| egress-policies | the egress policy of a **node** becomes a node policy `fork-<node>`; the policy of a **cascade member** only when the node is in exactly one position and has no policy of its own; rules the old compiler dropped anyway (zapret2, link-out on a node, WARP without WARP) are dropped with a reason. Everything else is written in full to `egress-policies-not-converted.json`: move it by hand |
| geo | geo sources with their own URLs become url sets (`<name>-site`, `<name>-ip`); the default runetfreedom source is not carried (the built-in sets are its place); categories become the composite sets `geo-custom` (domains) and `geo-custom-ip` (addresses) with the same names, lower-cased; `ext:geo-custom.dat:X` in stored rules becomes `ext:geo-custom:x`. **Nothing is rolled out to nodes**: do it from the geo screen when the sets are built |
| profile-engine | `engine = 'mtproto'` (an explicit mtg) becomes the native core: the same behaviour |
| hwid-trim | device user agents longer than 512 characters are cut (count in the report) |
| wg-unique | `wg_devices.public_key` becomes unique (a repeated key is a blocking finding) |
| drop-old-columns | `nodes.egress_tune`, `port_hopping_start/_end`, `cascade_position_nodes.egress_policy` go, their values first into the report |
| srr-report | **changes nothing**: lists the response rules that differ from a fresh install of this fork |

## What is lost or changes

| What | Why | What you do |
|---|---|---|
| zapret2: `hardening.zapret2`, `/applyEgress`, self-tune, `nodes.egress_tune` | not carried over by decision | values are in the report; clean the nodes (below) |
| Post-quantum REALITY / VLESS Encryption fields, `abusePolicy` of a profile | dropped by decision | **blocking**: re-issue the profiles first, or `--accept-loss` (and type the sentence): clients holding links built on them stop connecting |
| Egress policies of cascade members | one policy per node here | the unambiguous ones are converted, the rest are in the report |
| Geo sources and categories | another subsystem (geo sets) | converted; rollout to nodes is yours |
| Hysteria port-hopping range | the agent reports it now | comes back after the agent is reinstalled; until then the subscription does not carry it |
| Hysteria `pinnedPeerCertSha256` of a profile | the pin comes from the node's report now | listed under `config-keys-dropped`; reinstall the agent |
| Subscription body | other formats and orders (milestones 6.2, 6.4, 10.5, 12.x, 13.x) | links `/sub/<token>` stay the same |
| Response rules (User-Agent to format) | left as they are | the report lists the differences from a fresh install (Clash and NekoBox stay on `clash`/`singbox` instead of `mihomo`, WireGuard priority 60 instead of 65, no `v2rayNG` rule when v2rayN was edited) |
| Redis: rate counters, login lockouts, honeypot list | temporary | none |
| `hwid_user_devices.user_agent` over 512 characters | column type | cut |
| Tables `inbounds`, `group_inbounds` | dead since long | **blocking** when not empty |

## Nodes

The agent of the old fork speaks a different contract (no `/addUsers`,
`/assets`, `/connLog`, `/rotateCert` on one side, `/applyEgress` and
`/generateKeys` on the other). **Compatibility of the new panel with the old
agent is not promised**: reinstall every node right after the move. In the
panel: node, "Refresh bootstrap", run the command it shows on the node **with
`--reset`** (an agent is already installed; without it the installer asks on the
terminal). Then check the version in `/healthz`, a push of the config, and that
port hopping is back in the subscription.

Panel logins: the new panel does not accept the old administrator sessions (the
token has no `jti`): log in again with the same password and 2FA code. API
tokens keep working.

Leftovers of zapret2 on a node the move does not touch (remove by hand, only
where it was enabled):

```bash
cd /opt/ss-zapret2 && docker compose down; rm -rf /opt/ss-zapret2
systemctl disable --now iceslab-egress-selftune.timer
rm -f /etc/systemd/system/iceslab-egress-selftune.{service,timer} /usr/local/bin/iceslab-egress-selftune.sh
rm -f /etc/systemd/system/iceslab-node.service.d/zapret2-rw.conf /var/lib/iceslab-node/egress-tune.json
sed -i '/^ZAPRET2_/d' /etc/iceslab-node/env     # if the installer of this fork left it
systemctl daemon-reload
```

## Rollback

```bash
cd /opt/iceslab-new
scripts/ops/migrate-from-fork.sh --rollback --panel-dir /opt/iceslab
```

The database named `<db>_pre_fork` is put back, the migrated one is kept as
`<db>_migrated_<time>`, `origin` and the commit of the old checkout return, the
images tagged `:pre-fork` start. What changed in the panel after the move is
lost. Run `--run` again later if you wish. The old database and images are kept
until you delete them; do so only when you are sure.

## Reading the findings of the pre-check

`blocking` stops `--run`:

| code | meaning | way out |
|---|---|---|
| `not-old-fork-commit` | the journal is not the 65 migrations of `040410ac` | update the old fork to `040410ac` |
| `journal-unfinished` | a migration is failed or rolled back | resolve it in the old fork |
| `already-migrated` | the database holds migrations of this fork | nothing to do |
| `schema-drift` | the schema differs from the old fork's (by hand?) | undo the change or ask |
| `link-protocol-unknown` | a cascade `link_protocol` this fork cannot read | fix the cell in the old panel |
| `cascade-link-no-port` | a cascade link has no port | rebuild the link |
| `binding-transport-unknown` | a binding of a profile with an unknown protocol | remove or fix it |
| `wg-key-repeated` | a WireGuard public key held twice | revoke / re-issue |
| `dead-table-not-empty` | `inbounds` / `group_inbounds` has rows | see what they are, empty the table |
| `lossy-profiles` | profiles with fields this fork dropped | re-issue, or `--accept-loss` |
| `jwt-secret-missing` | no `JWT_SECRET` | it must be in `.env.production` |

`warnings` and `info` do not stop it; read them. `stored-content-unreadable`
names rows the new panel's schemas would refuse.

## Not covered

Real operator data was not available: the move was tried on a synthetic
installation filled through the old panel's API. Manual changes of the database
beyond what the pre-check compares, unusual JSON values, very large history
tables (copy time, table rewrites) and the `remnawave-minishop` store are not
verified. The state before the move is in the backup, the old database and the
old images: keep them until the new panel has served for a while.
