# Mini Shop stand

A manual differential test of the Remnawave facade. The unmodified
[remnawave-minishop](https://gitlab.com/3252a8/remnawave-minishop) **v3.8.6** is
brought up twice, once against this panel's facade and once against a real
Remnawave **3.4.10** (the version that tag pins in
`deploy/dev/remnawave-versions.lock.json`). Each half gets the same tariff
catalogue and node traffic, runs the same scripted purchase in the shop's QA
mode, and then a walk of the shop's admin API on the user it just bought for.
Three comparisons follow: the purchase's trace of panel calls, the admin walk's
trace (both judged by the shop's own contract registry,
`apps/panel-backend/src/modules/remnawave-compat/contracts/minishop-contract.json`),
and what the admin pages rendered (status and shape).

The shop reaches the facade through **this repo's frontend image** (`panel-front`),
not straight at the backend, so an nginx that serves the facade prefix from the
SPA fallback (HTTP 200, `index.html`) is seen here and nowhere else.

Not part of CI. Nothing is written into the shop's checkout.

**Never run it against a panel that holds real data.** The stand creates users
and writes to the panel's database, and `up-iceslab` deletes panel users it finds
under the buyer's and the shop's demo-seed addresses. Use a dedicated lab panel.

## What it needs

- Docker with compose v2 (`up --wait`), curl, python3 (standard library only),
  openssl, sed. Network access: the first build of the shop images compiles
  nginx with brotli and takes several minutes.
- A checkout of the shop at the tag, outside this repo:
  `git clone https://gitlab.com/3252a8/remnawave-minishop.git && git -C remnawave-minishop checkout v3.8.6`
  (`stand.sh` refuses any other version; `STAND_ANY_SHOP_VERSION=1` overrides).
- A lab panel of this repo on the host, dev process on `127.0.0.1:3000` (it must
  listen on `0.0.0.0`, the default), with `REMNAWAVE_COMPAT_ENABLED=true`, the
  facade's migrations applied, and the prefix in `REMNAWAVE_COMPAT_PREFIX`
  (default `rw`).
- **A node in that panel's database.** The stand writes three hourly traffic
  rows for the panel's first undeleted node (`nodes`, `node_usage_history`), so
  the admin statistics page has something to compare, and refuses without one.
  A live node is not needed, a row is. The stand does not create it. For the
  later premium probe the panel also needs a profile bound to that node. Where
  the panel's database runs: `PANEL_DB_CONTAINER`, `PANEL_DB_USER`,
  `PANEL_DB_NAME` (defaults `iceslab-postgres`, `iceslab`, `iceslab`, the dev
  database of this repo's `docker-compose.yml`); `docker exec` access to it.
- An `icp_` API token for it: `PANEL_ADMIN_USER=... PANEL_ADMIN_PASSWORD=...
  ./stand.sh mint-token` writes `.runtime/panel-token` (gitignored).
- Free host ports: 3000 (panel), 8080 and 8082 (shop), 8087 (`panel-front`),
  6768 (shop database, reference half); reference half also 3100, 3001, 6767,
  3010. About 1.5 GB of RAM per half. Only one half can be up (shared container
  names).

External images: `postgres:17.12`, `redis:7-alpine`, `valkey/valkey:9-alpine`,
`remnawave/backend:3.4.10`, `remnawave/subscription-page:7.2.6`, and the shop's
own pinned build bases (alpine, ubuntu, node, nginx). The shop's images are built
from source; `3252a8/remnawave-minishop-*` from a registry are not used.
`iceslab-frontend:stand` is built from `apps/panel-frontend/Dockerfile` of this
repo.

## Commands

All from this directory, with `MINISHOP_DIR` set.

| | |
|---|---|
| `./stand.sh up-iceslab` | shop -> facade (through `panel-front`); seeds the shop's demo fixtures; creates the stand's two squads on the panel and strips their profiles; stores the tariff catalogue; asserts the frontend image forwards the facade prefix and still serves the SPA |
| `./stand.sh up-ref` | shop -> real Remnawave 3.4.10 in docker; stores the same catalogue |
| `./stand.sh check iceslab\|ref` | what `up-*` asserts, on a stand that is up: admin seeded, the worker has a panel key |
| `./stand.sh seed-tariffs` | the catalogue step alone |
| `./stand.sh half iceslab\|ref DIR` | one half from dropped volumes: up, node traffic, purchase, admin walk; writes `<half>-buy.*` and `<half>-admin.{log,jsonl,trace}` into `DIR` |
| `./stand.sh differential DIR` | both halves, then `verdict`. **Exit 0** the halves agree, **1** they differ, **2** a comparison refused (an empty or missing input: the run proved nothing) |
| `./stand.sh verdict DIR` | the three comparisons on the files a differential left. No docker |
| `./stand.sh compare-admin REF.jsonl CAND.jsonl` | what the admin pages rendered, two walks |
| `./stand.sh selftest` | the admin comparator against known answers. No docker, no shop checkout, no panel |
| `./stand.sh down` / `reset` | stop both halves / and drop their volumes |
| `./stand.sh status`, `logs [n]` | what runs; the shop's backend and worker logs |
| `./stand.sh mark` | a timestamp for `trace` |
| `./stand.sh trace [file] [since]` | the shop's panel calls, `METHOD label status`, from both its processes |
| `./stand.sh compare REF CAND` | multiset diff, statuses judged by the registry's `success_statuses` |
| `./stand.sh subpage TOKEN...` | the install document the facade serves for a subscription token, through the shop's own validator, plus seven deliberate breakages that must all be rejected. No docker |
| `./buy.sh [email]` | the purchase: email code (QA auth), QA payment, signed webhook. `STAND_ENV` picks the env file |

A differential run is `export MINISHOP_DIR=...; ./stand.sh differential "$(mktemp -d)"`:
two full halves with their volumes recreated, tens of minutes.
Run it twice in a row: the second run must give the same picture as the first
(that is the check on the panel cleanup).

Exit code 0 means identical, or only differences the shop's registry accepts
and the `ACCEPTED_DIVERGENCE` table in `compare_admin.py` names. Any other
difference is either a facade defect or a property of the stand; write down
which, with the lines. `ACCEPTED_DIVERGENCE` entries each carry a reason; the
comparator reports an entry that matched nothing as stale, and a divergence
that matches no entry as new.

`admin.sh <out.jsonl> [buyer]` is the walk itself (the shop's admin API, signed
in as the admin the demo seed creates). It exits non-zero when a step on its
`MUST_SUCCEED` list (the panel-touching mutations) did not answer 2xx, because
a refusal on both halves compares clean while proving nothing.

## Files

- `iceslab.env`, `remnawave-ref.env` - the shop's env for each half, derived
  from its `deploy/dev/remnawave-dev.env.example`. `stand.sh` writes the working
  copies to `.runtime/` with the token and absolute paths filled in; the
  templates are never modified.
- `admin.sh`, `compare_admin.py` - the admin walk and the comparison of what it
  rendered (`--selftest` runs offline). `seed_node_traffic.py` - the traffic
  rows. `tariffs.template.json`, `seed_tariffs.py`, `squad_names.py`,
  `squad_ids.py` - the two-tariff catalogue (squads written `@<name>`, resolved
  per half to that panel's uuids; `standard` is bought and carries the premium
  squad, `pro` does not, so the switch removes a squad).
- `stand.override.yml` - the iceslab half only: version stamp as build args,
  the shop's demo seed, `panel-front`. `data-volume.override.yml` - a writable
  `/app/data` as a named volume, both halves.

## Traps

- `panel-front` proxies to an **address** (`PANEL_BACKEND_ADDR`, the docker
  bridge gateway by default); a variable `proxy_pass` never reads `/etc/hosts`,
  so `host.docker.internal` does not work there.
- The panel is not a stand volume, so `reset` does not clean it. A buyer left
  over from an earlier run makes the purchase an UPDATE on our half and a CREATE
  on the reference one; `up-iceslab` removes the buyer and the demo-seed users
  from the panel for that reason.
- The reference shop's worker only sees `PANEL_API_KEY` through its env file;
  `stand.sh` fills it from the shop's compose, and asserts both workers have one.
- The shop's demo seed may exit non-zero; `stand.sh` checks the admin row.
- The shop's Dockerfile needs a real `.git` directory in the checkout (a git
  worktree does not work); `MINISHOP_BUILD_*` args carry the version.
- `compare_traces.py` finds the registry relative to this repo's root.
- The shop caches the squad list and the system metadata for 300 s, so counters
  of those lines in the admin trace may differ by one between runs; the
  comparison says so aloud and the exit code stays non-zero.
- Order matters after the catalogue is stored: `backend` and `worker`, then
  `frontend` last and alone (its nginx resolved the old backend address). `up-*`
  does it; do it by hand after `seed-tariffs`.
- Do not edit the panel's sources while a half runs: the dev process restarts
  and the shop's calls fail halfway.
- The reference half writes to the reference Remnawave's tables
  (`nodes`, `nodes_usage_history`), whose shape depends on its version;
  `seed_node_traffic.py` checks the columns it writes and stops by name.
