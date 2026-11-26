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

Three probes run on the same stand and the same shop checkout (see
[Probes](#probes)). Not part of CI. Nothing is written into the shop's checkout.

**Never run it against a panel that holds real data.** The stand creates users
and writes to the panel's database, and `up-iceslab` deletes panel users it finds
under the buyer's and the shop's demo-seed addresses. Use a dedicated lab panel.

## What it needs

- Docker with compose v2 (`up --wait`), curl, python3 (standard library only),
  openssl, sed. The probes also pull `nginx:1.27-alpine` (the TLS proxy and the shim). Network access: the first build of the shop images compiles
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
  A live node is not needed, a row is. The stand does not create it. **The
  premium probe also needs a profile bound to a node** (the node's status does not
  matter): it attaches the panel's profiles to the stand's two squads and refuses,
  naming this, when a squad still grants no node. The stand does not create the
  profile either. Where
  the panel's database runs: `PANEL_DB_CONTAINER`, `PANEL_DB_USER`,
  `PANEL_DB_NAME` (defaults `iceslab-postgres`, `iceslab`, `iceslab`, the dev
  database of this repo's `docker-compose.yml`); `docker exec` access to it.
- An `icp_` API token for it: `PANEL_ADMIN_USER=... PANEL_ADMIN_PASSWORD=...
  ./stand.sh mint-token` writes `.runtime/panel-token` (gitignored).
- Free host ports: 3000 (panel), 8080 and 8082 (shop), 8087 (`panel-front`),
  8444 (`webhook-tls`) and 8086 (`panel-shim`) for the probes,
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
| `./stand.sh selftest` | the admin comparator, the churn verdict and the missing-route predicate against known answers. No docker, no shop checkout, no panel |
| `./stand.sh down` / `reset` | stop both halves / and drop their volumes |
| `./stand.sh status`, `logs [n]` | what runs; the shop's backend and worker logs |
| `./stand.sh mark` | a timestamp for `trace` |
| `./stand.sh trace [file] [since]` | the shop's panel calls, `METHOD label status`, from both its processes |
| `./stand.sh compare REF CAND` | multiset diff, statuses judged by the registry's `success_statuses` |
| `./stand.sh churn-probe [N]` | **Probe.** N users (default 40) are seeded, one is deleted inside the shop's paged walk of `/users/stream`, and the shop's "Panel records checked" is compared with the panel's count. Needs `CHURN_PAGING=1 ./stand.sh up-iceslab`. Exit 0 nobody lost, 1 someone lost, **2** the run proved nothing |
| `./stand.sh webhook-probe` | **Probe.** Signed webhook bodies to the shop directly and through a TLS nginx. Exit 0 or 1 |
| `./stand.sh premium-probe [LOG]` | **Probe.** A premium purchase, the shop's usage snapshot, then a demotion through the bulk route and a connection drop. About 13 minutes. `HIDE_NODES_USAGE=1 ./stand.sh up-iceslab` first for the fallback route. Exit 0, 1, or **2** (the run proved nothing) |
| `./stand.sh full DIR` | `differential`, then every probe above (the churn probe once refused and once passing, `premium-probe` twice); about an hour and a half |
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

## Probes

The three probes are not part of the differential and nothing starts them
automatically (`full` is the one command that runs all of them). Each writes to
the lab panel and cleans up after itself; after them `differential` must give the
same picture as before.

Each probe first decides whether the run proved anything, and only then what it
proved: a run that never reached the code under test **exits 2** (a refusal, not
a pass and not a finding). A probe that cannot fail proves nothing, and that is
the failure these were written against.

- **`churn-probe`**: the shop's fleet sync walks `/users/stream` to decide who
  still exists, and a user it never sees is read as deleted from the panel. With
  offset paging, one row deleted ahead of the cursor shifts the tail and one
  user is lost; the facade's cursor is a keyset. `CHURN_PAGING=1 up-iceslab`
  sets the shop's own `PANEL_ALL_USERS_PAGE_SIZE` (5) and
  `PANEL_ALL_USERS_PAGE_DELAY_SECONDS` (1.0) so a walk lasts several seconds.
  The probe seeds users through the panel's native API, deletes the newest (on
  the first page, so already collected) a few seconds after the first page, and
  compares the shop's count with the panel's. Pages and the moment of the
  deletion come from `panel-front`'s access log (`churn_verdict.py`). It refuses
  (exit 2) when the walk took one page or followed no cursor (no `CHURN_PAGING`),
  or when the deletion fell outside the walk, and cleans its users up, checking
  that none are left.
- **`webhook-probe`** checks **the shop and the proxy, not the panel**. The
  facade signs the raw body (HMAC-SHA256, `X-Remnawave-Signature`), and in
  production an operator's proxy sits between it and the shop. The bodies are
  composed in `stand.sh` in the shape the facade emits and no panel code runs:
  an ASCII body and an escaped non-ASCII body, each direct and through the TLS
  nginx (`webhook-tls`, a self-signed certificate made in `.runtime/certs`),
  all accepted (200); the same body altered by a byte after signing is rejected
  (401). Then the other event names the facade sends (the 24-hour stage, a new
  device with a `wg:` tunnel id) must appear in the shop's log, and
  `transcode_probe.py` shows a raw UTF-8 body breaking under a charset
  transcoding while the escaped one cannot.
- **`premium-probe`** makes the real shop call the capability routes the panel
  otherwise guards only with its own tests. It buys the `standard` tariff, which
  carries the premium squad, gives the stand's squads the panel's profiles (the
  premium squad must grant a node: see What it needs), drops the shop's squad
  cache, and waits for a full tick of the tariff worker. Stage one: the shop's
  `premium_usage_snapshot` must be `source=multi_node_usage complete=True`
  (`POST /bandwidth-stats/nodes/usage`). Stage two: usage 20% over the premium
  allowance is written to `node_user_usage_history` and the shop must demote the
  user through `POST /users/bulk/update-squads` (selector `userIds`) and drop
  connections (`POST /connections/drop`); `assert_demoted.py` then checks on the
  panel that exactly one of the stand's squads is left. With
  `HIDE_NODES_USAGE=1 ./stand.sh up-iceslab` the shop reaches the panel through
  `panel-shim`, an nginx that forwards to `panel-front` and answers that one
  path with a router miss. The shop must record `multi-node-usage=False` and
  build the snapshot from the fallback route (`source=multi_node_top_users`).
  The shim is checked first in both directions (`assert_shim_hides_only_the_one_route`).
  No full tick in eleven minutes, or no subscription to meter, is a refusal. The
  buyer, its usage rows and the squads' profiles are removed afterwards.

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
- `churn_verdict.py`, `reads_as_missing_route.py` (`--selftest` each),
  `transcode_probe.py`, `premium_fixture.py`, `assert_demoted.py`,
  `webhook-tls.conf`, `panel-shim.conf` - the probes.
- `stand.override.yml` - the iceslab half only: version stamp as build args,
  the shop's demo seed, `panel-front`, and the probes' `webhook-tls` and
  `panel-shim` (profiles `tls` and `shim`). `data-volume.override.yml` - a writable
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
- `CHURN_PAGING` and `HIDE_NODES_USAGE` are read by `up-iceslab` only and kept in
  `.runtime/stand-mode.env`, because the shop's containers read their env when
  they are created. `premium-probe` reads the mode to know which route to expect;
  the churn verdict refuses on a stand without paging. `reset` forgets the mode.
- The panel's user delete is a soft one, so the premium probe removes its usage
  rows itself.
- Do not edit the panel's sources while a half runs: the dev process restarts
  and the shop's calls fail halfway.
- The reference half writes to the reference Remnawave's tables
  (`nodes`, `nodes_usage_history`), whose shape depends on its version;
  `seed_node_traffic.py` checks the columns it writes and stops by name.
