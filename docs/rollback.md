# Rolling back

English | [Русский](rollback.ru.md)

Migrations of the database are never rolled back: a database that a newer build
has migrated cannot run under older code. A rollback therefore always means the
OLD code with the OLD database (a backup or the copy kept by the move), and the
order of the steps matters.

## 1. After the move from the old fork (the usual path)

If the installation came from the old fork (`040410ac`) through
[migrate-from-fork](migrate-from-fork.md), go back with its own command; it is
the first choice and needs no backup of yours:

```bash
cd /opt/iceslab-new
scripts/ops/migrate-from-fork.sh --rollback --panel-dir /opt/iceslab
```

It puts the database kept as `<db>_pre_fork` back, checks the old code out, tags
the old images as current and starts the old panel. What changed in the panel
after the move is lost. The migrated database is kept as `<db>_migrated_<time>`.

## 2. After an ordinary upgrade of this fork

Use this when you upgraded this fork by `scripts/ops/deploy.sh` and want the
previous ref back. You need a backup taken BEFORE the upgrade
(`scripts/ops/iceslab-backup.sh`); a backup taken after it holds the new schema.

```bash
cd /opt/iceslab
# 0. (once, before upgrading) the backup of the old state
scripts/ops/iceslab-backup.sh --out ./backups
# ... upgrade, trouble ...
# 1. the old code and its images
git checkout <old ref>
ICESLAB_REF=<old ref> scripts/ops/deploy.sh
# 2. the old database, with the panel started from the old images
scripts/ops/iceslab-restore.sh ./backups/iceslab-backup-<time>.tar.gz
```

Why in this order:

- The migrations of the new build stay in the database. `deploy.sh` of the old
  ref rebuilds the old images; the restore then puts the old database under
  them. Restoring first and checking out later would leave a new build running
  on an old database, and its `migrate` step would apply the migrations again.
- `iceslab-restore.sh` brings `backend` and `frontend` up with `docker compose
  up -d` from the current compose file and images (the `migrate` step included),
  so what runs is the build of the checkout, not whatever containers were left.
- The restore stops the panel, drops and recreates the database, loads the dump
  and Redis' snapshot, and does not overwrite `.env.production` (the archive's
  copy is saved aside and its path is printed).

Since this version a backup records the commit (`gitSha`, in a git checkout) and
the migrations (`migrations`: count and the last name) in `manifest.json`. The
restore prints them and WARNS, without refusing, when the archive's database has
migrations the current code does not: then do step 1 first (the commit is in the
message). An archive made before this version has neither field and restores as
before.

### The restore of `v0.3.1`

The `iceslab-restore.sh` of `v0.3.1` runs `docker compose start backend
frontend`: it starts the containers that are left, of whatever build. So before
restoring with it, `deploy.sh` of the old ref must have replaced the containers
of the new build (step 1 above); with no containers at all it fails on the
missing `migrate` dependency. If you restore with the `v0.3.1` script, run
`ICESLAB_REF=v0.3.1 scripts/ops/deploy.sh` first, as above, and check
`docker ps` shows the images of that build.

## What a rollback does not bring back

Changes made in the panel after the backup (users, hosts, traffic), and what the
nodes were told since. Nodes keep working on their last configuration and take
the restored one at the next push.
