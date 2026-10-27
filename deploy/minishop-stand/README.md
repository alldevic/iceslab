# Mini Shop stand

An **unmodified** [remnawave-minishop] driving this panel through its
Remnawave-compatible API (`/<REMNAWAVE_COMPAT_PREFIX>/api`, default `/rw/api`),
and the same shop driving a real Remnawave 3.2.3 for comparison. Nothing is
written into the shop's checkout: its compose files are referenced by path, and
every override and env file lives in this directory.

## What it checks

| Tier | What | Where | Needs the stand |
|---|---|---|---|
| 1 | Every rw3 operation in the shop's contract registry reaches a route; a missing route answers in the shape the shop classifies as missing | `apps/panel-backend/src/modules/remnawave-compat/remnawave.contract.test.ts` | no |
| 1 | The facade's own rate limit | `…/remnawave.ratelimit.test.ts` | no |
| 2 | The shop really sells a subscription through the facade | `stand.sh up-iceslab`, `buy.sh` | yes |
| 3 | The same against Remnawave 3.2.3, call traces compared | `stand.sh differential` | yes |
| 3 | The shop's admin pages against both panels: what they render and what they call | `admin.sh`, `compare_admin.py` | yes |
| 3 | Probes for specific risks: per-node premium accounting and demotion, a user lost while the fleet sync pages, a signed webhook through a TLS proxy | `stand.sh premium-probe`, `churn-probe`, `webhook-probe` | yes |

Tier 1 runs in the ordinary `pnpm test`. Tier 2 answers "the shop did not
break"; tier 3 answers "the shop took the same path as against Remnawave". The
shop logs one line per panel response with an identifier-free operation label
and the status, so two runs compare without normalising ids or timestamps. A
call only the reference makes is a call that never reached our facade.

3.2.3 is the Remnawave version the shop's `deploy/dev/remnawave-versions.lock.json`
pins at v3.6.1, i.e. the one the shop release itself is certified against.

## Prerequisites

- A shop checkout at **v3.6.1** (`MINISHOP_DIR`, required).
- The panel running with the facade on: `REMNAWAVE_COMPAT_ENABLED=true`,
  `REMNAWAVE_COMPAT_WEBHOOK_URL=http://127.0.0.1:${SHOP_PORT}/webhook/panel`
  and `REMNAWAVE_COMPAT_WEBHOOK_SECRET` equal to the shop's `PANEL_WEBHOOK_SECRET`
  (see `iceslab.env`). `stand.sh` checks the facade answers before it starts
  anything.
- A panel API token (`icp_…`, from `POST /api/api-tokens`) in
  `PANEL_TOKEN_FILE`.
- The panel's frontend image, which the shop reaches the facade through, as a
  real deploy does: `docker build -f apps/panel-frontend/Dockerfile -t iceslab-frontend:stand .`
  from the repo root (`up-iceslab` builds it when missing).
- Docker. One shop is six containers and about 1.5 GB; the reference adds
  Remnawave, its database, valkey and the subscription page, about 1 GB more.

## Variables

| Variable | Default | |
|---|---|---|
| `MINISHOP_DIR` | none, required | the shop checkout |
| `PANEL_URL` | `http://127.0.0.1:3000` | the panel's backend |
| `PANEL_TOKEN_FILE` | `.runtime/panel-token` | the `icp_` token |
| `PANEL_DATABASE_URL` | `DATABASE_URL` from the repo's `.env` | for fixtures written with psql |
| `PANEL_DB_CONTAINER` | `iceslab-postgres` | the container psql runs in |
| `PANEL_DB_NAME` | `iceslab` | the panel's database, for `seed_node_traffic.py` |
| `SHOP_PORT` | `8080` | host port of the shop's backend (the panel's webhook URL points here) |
| `ICESLAB_BACKEND_ADDR` | docker bridge gateway `:3000` | where the frontend image proxies the facade to |
| `REMNAWAVE_COMPAT_PREFIX` | `rw` | the facade's prefix |
| `CHURN_PAGING`, `CHURN_PAGE_SIZE`, `CHURN_PAGE_DELAY`, `CHURN_DELETE_AFTER` | off, 5, 1.0, 4 | slow paging for `churn-probe` |
| `HIDE_NODES_USAGE` | off | put `panel-shim` in front of the facade (below) |

Everything generated (the env copies with the token filled in, certificates,
the token itself by default) goes to `.runtime/`, which is not tracked.

## Running

```sh
export MINISHOP_DIR=~/src/remnawave-minishop   # at v3.6.1
./stand.sh selftest                  # the comparators against known answers; no docker
./stand.sh half iceslab /tmp/run     # reset, up, buy, admin walk, traces
./stand.sh differential /tmp/run     # both halves and the three comparisons
./stand.sh full /tmp/run             # the differential and every probe, ~1 hour
```

Both halves in one command is a requirement, not a convenience: two halves run
an hour apart by hand are two different experiments. The two stands share
container names, so only one is up at a time; `reset` drops the shop's volumes,
and the next half starts clean.

Probes, against a stand that is up:

```sh
CHURN_PAGING=1 ./stand.sh up-iceslab && ./stand.sh churn-probe
./stand.sh webhook-probe
./stand.sh premium-probe
HIDE_NODES_USAGE=1 ./stand.sh up-iceslab && ./stand.sh premium-probe
./stand.sh subpage <subscription-token>
```

- **churn-probe** seeds users, starts the shop's fleet sync with small slow
  pages, deletes a user the walk has already collected and compares the shop's
  `Panel records checked` with the panel's count. It first decides whether the
  run proved anything: the walk's pages are counted in the request log of the
  nginx in front of the facade, and a walk of one page, with no cursor, or that
  did not span the deletion is a refusal (exit 2), not a pass.
- **premium-probe** buys, waits for two tariff ticks, and checks the shop built
  a complete per-node usage snapshot and then demoted the user (bulk squads and
  connection drop). With `HIDE_NODES_USAGE=1` the shop reaches the panel through
  `panel-shim`, an nginx that answers `POST …/bandwidth-stats/nodes/usage` the
  way the shop reads as an absent route, and the probe expects the fallback
  `POST …/bandwidth-stats/nodes/users` instead.
- **webhook-probe** sends a signed webhook through a TLS nginx, and a body
  changed after signing that must get 401.
- **subpage** runs the install document the panel emits through the shop's own
  validator, plus seven mutations it must reject.

Purchases use the shop's QA mode (`QA_AUTH_ENABLED`, `QA_PAYMENT_ENABLED`): no
Telegram, no payment gateway. `PANEL_WRITE_MODE=live` in both env files on
purpose; the shop's example ships `dry_run`, under which nothing is sent.

## Known differences from the reference

- **Seeded users.** The reference gets the shop's two demo users from the shop's
  SQL seed; on our half the shop's sync creates them through the API. The
  purchase trace therefore has two more `POST /users` and their lookups on our
  side; the purchase itself matches.
- **Accepted divergences** of the admin walk are listed, with the reason for
  each, in `ACCEPTED_DIVERGENCE` in `compare_admin.py`.
- The shop caches `/system/metadata` and `/internal-squads` for 300 s, so
  whether those calls fall inside a trace window depends on timing, not on the
  panel.

## Traps

- Our panel is not a stand volume. Whatever a run leaves on it (users from a
  probe, a profile attached to a squad, users the shop's sync created) changes
  the next run; each command removes what it created and establishes the
  fixture it needs instead of inheriting one.
- Do not edit the panel's sources during a run: `tsx watch` restarts it and half
  the shop's requests fail, which reads as a real divergence.
- The compose project name is pinned (`STAND_PROJECT`), so pointing
  `MINISHOP_DIR` at another checkout does not create a second project that
  `reset` would miss.
- The shop's own demo seed exits non-zero at v3.6.1; the stand checks the admin
  row it needs instead of the exit code.

[remnawave-minishop]: https://gitlab.com/3252a8/remnawave-minishop
