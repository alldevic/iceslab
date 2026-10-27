# Remnawave-compatible API

Iceslab can answer a subset of the Remnawave 3.x panel API, so a shop or bot
written against Remnawave can sell and manage subscriptions on an Iceslab panel
without a change to its code. It was built against
[remnawave-minishop](https://gitlab.com/3252a8/remnawave-minishop) and is
checked against that shop's own registry of the calls it makes (pinned at
v3.8.3, `apps/panel-backend/src/modules/remnawave-compat/contracts/`).

The facade is off by default. Off, none of its routes exist and the panel
behaves exactly as without it.

## Turning it on

In `.env.production`:

| Setting | Default | What it does |
|---|---|---|
| `REMNAWAVE_COMPAT_ENABLED` | `false` | Mounts the facade. |
| `REMNAWAVE_COMPAT_PREFIX` | `rw` | The facade lives at `/<prefix>/api/*`. One path segment of `[a-zA-Z0-9_-]`, never `api` (the panel's own API is there). |
| `REMNAWAVE_COMPAT_WEBHOOK_URL` | empty | Where the shop takes Remnawave webhooks, e.g. `https://shop.example.com/webhook/panel`. |
| `REMNAWAVE_COMPAT_WEBHOOK_SECRET` | empty | The secret the shop checks `X-Remnawave-Signature` with. |
| `REMNAWAVE_COMPAT_WEBHOOK_CONCURRENCY` | `32` | Webhook deliveries in flight at once (1–256). |

Webhooks go out only when both the URL and the secret are set; with one of
the two the panel says so in its log at start. The panel's own webhooks
(`WEBHOOK_URLS`) are separate and unaffected.

The frontend container forwards `/<prefix>/api/` to the backend. It reads the
same `REMNAWAVE_COMPAT_PREFIX`, which `docker-compose.prod.yml` passes to both.
If you put your own reverse proxy in front instead, forward that prefix to the
backend as you do `/api/` and the subscription path.

Then mint an API token on the panel (Settings → API tokens) and give the shop:

| Shop setting (remnawave-minishop) | Value |
|---|---|
| `PANEL_API_URL` | `https://<panel>/<prefix>/api` |
| `PANEL_API_KEY` | the `icp_…` token |
| `PANEL_WEBHOOK_SECRET` | the same value as `REMNAWAVE_COMPAT_WEBHOOK_SECRET` |

### Token scopes

A token without scopes reaches everything. A scoped token is held on the
facade to the same native scopes as on `/api/*`:

| Facade resource | Scope |
|---|---|
| `users`, `connections` | `users:read` / `users:write` |
| `internal-squads`, `external-squads` | `squads:read`; the bulk membership routes need `users:write` |
| `hwid` | `hwid-devices:read` / `hwid-devices:write` |
| `nodes` | `nodes:read` / `nodes:write` |
| `hosts` | `hosts:read` |
| `system/metadata` | `system:read` |
| `system/stats*`, `bandwidth-stats/nodes` | `dashboard:read` |
| per-user bandwidth (`…/users`, `…/nodes/usage`) | `users:read` |
| `subscriptions`, `subscription-page-configs`, `sub` | `sub:read` |

For remnawave-minishop: `users:read`, `users:write`, `squads:read`,
`hwid-devices:read`, `hwid-devices:write`, `nodes:read`, `nodes:write`,
`hosts:read`, `dashboard:read`, `system:read`, `sub:read`.

The facade allows 1200 requests a minute per client instead of the panel's
100: a shop syncing its user base bursts, and a 429 in the middle of an
activation is a payment the buyer got nothing for.

The geo-block (`ADMIN_ALLOWED_COUNTRIES`) covers `/api/*` only. The facade is
called server to server from wherever the shop is hosted, so it is guarded by
the token and its scopes.

## How Iceslab maps onto Remnawave

- **Users** are identified by a number. Remnawave 3.x has no user UUID on the
  wire; every Iceslab user gets a sequential number that is never reused, not
  even after the user is erased by retention. The panel's own UUID is never
  sent. `shortUuid` and the tail of `subscriptionUrl` are the subscription
  token.
- **Internal squads** are squads. The system squad "All" is not shown and
  cannot be assigned. An empty squad set means no access, as in Remnawave:
  such a user is put in the system squad "No access (remnawave-compat)", which
  has no profiles and cannot be edited or deleted. With the facade on, members
  of a deleted squad go there too, instead of into "All".
- **External squads** are not a concept here. The id a shop sets on a user is
  stored and echoed back as is.
- **Traffic limits** are kept to the byte (`0` = unlimited); the device limit
  `0` is an explicit "no limit".
- **Hosts**: each binding (a profile on one port of a node) is an inbound.
  Hidden hosts are listed with `isHidden: true`.
- **Restarting a node** pushes its full configuration and users again, the
  same push an agent restart triggers.
- **Dropping connections** takes the user off the chosen nodes and puts them
  back at once; if putting back fails, the panel retries it in the
  background.
- **Devices** are the clients that sent `x-hwid` and, after them, the user's
  WireGuard devices (a key per client, issued with the subscription), oldest
  first, so the shop's "N of M" counts both. A WireGuard device has `hwid`
  `wg:<id>`, platform `WireGuard/AmneziaWG`, its address as the model and its
  traffic as the OS line. One that has never moved traffic is a free slot and
  is listed only with the panel setting "Unused WireGuard devices"; deleting
  one revokes it (the next download issues a new key), and a device of
  another user is never revoked.

## Endpoints

All under `/<prefix>/api`. Answers are `{"response": …}`; errors are
`{"errorCode", "message"}` with Remnawave's codes where the shop branches on
them (`A019` username taken, `A063` no such user, `A219` no node matched).
A route that is not here answers a plain 404 with no `errorCode`, which the
shop reads as "this panel does not have it".

| Area | Routes |
|---|---|
| Version | `GET /system/metadata` (reports `3.3.2`) |
| Users | `POST /users`, `PATCH /users`, `GET /users/:id`, `GET /users/by-username/:username`, `GET /users/stream` (cursor; `telegramId` and `email` filters), `GET /users` (offset), `DELETE /users/:id`, `POST /users/:id/actions/{enable,disable,reset-traffic,revoke}`, `POST /users/bulk/update-squads`, `POST /connections/drop` |
| Squads | `GET /internal-squads`, `GET /internal-squads/:uuid`, `GET /internal-squads/:uuid/{accessible-nodes,nodes}`, `POST /internal-squads/:uuid/bulk-actions/add-many-users`, `DELETE /internal-squads/:uuid/bulk-actions/remove-many-users`, `GET /external-squads/:uuid` |
| Devices | `GET /hwid/devices/:userId`, `POST /hwid/devices/delete`, `GET /hwid/devices/stats`, `GET /hwid/devices/top-users` |
| Nodes, hosts | `GET /nodes`, `POST /nodes/:uuid/actions/restart`, `POST /nodes/actions/restart-all`, `GET /hosts` |
| Statistics | `GET /system/stats`, `GET /system/stats/bandwidth`, `GET /system/stats/nodes`, `GET /bandwidth-stats/nodes`, `GET /bandwidth-stats/users/:id`, `GET /bandwidth-stats/nodes/:uuid/users`, `POST /bandwidth-stats/nodes/users`, `POST /bandwidth-stats/nodes/usage` |
| Subscription | `GET /sub/:token` (redirects to the subscription link), `GET /subscriptions/subpage-config/:shortUuid`, `GET /subscription-page-configs[/:uuid]` |

## Webhooks

Signed with `X-Remnawave-Signature` (HMAC-SHA256 of the raw body). The body is
`{name, payload: {user: {id, telegramId, email, expireAt}}, meta}`, where `id`
is the user's number, with every non-ASCII character escaped so no proxy can
change the signed bytes.

| Event | When |
|---|---|
| `user.expires_in_72_hours`, `…_48_…`, `…_24_…` | A scan every 10 minutes, once per user, stage and term. Delivered at least once: a failed delivery is retried on the next scan, and a renewal starts the stages again. The 24-hour one is the shop's auto-renew charge. |
| `user.expired` | When the expiry check moves an active or limited user to expired. |
| `user_hwid_devices.added` | When a subscription request brings a device the user did not have, with what the client said about itself; and when a WireGuard device moves traffic for the first time. |

## Not there yet

- The subscription page config answers `{}`, and the shop shows its own
  install page built from the subscription link.
- Remnawave 2.x (UUID users) is not served.
