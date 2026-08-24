# Iceslab Admin Frontend

React 19 + Vite 8 SPA for the Iceslab admin UI.

## Stack

- React 19 + TypeScript
- Vite 8: dev server and build, served by nginx in prod
- Mantine 8: UI kit (AppShell, Table, Form, Modal, Notifications, MultiSelect, SegmentedControl)
- TanStack Query 5: server state with cache invalidation on mutation
- Zustand 5 + persist middleware: auth token kept in localStorage
- React Router DOM 7: routes + ProtectedRoute gate
- Axios: HTTP client with JWT interceptor and 401-clear-session interceptor

## Pages

| Route | Page | Notes |
|---|---|---|
| `/login` | LoginPage | Renders "Create first admin" when no admin exists yet |
| `/users` | UsersPage | CRUD, traffic limits + reset strategies, `enabledProtocols` MultiSelect, soft-delete confirm modal |
| `/nodes` | NodesPage | CRUD + one-time mTLS payload modal at create (admin must save it, panel never re-emits) |
| `/profiles` | ProfilesPage | Per-protocol form (Hysteria / Xray / AmneziaWG / Naive / SS / MTProto / Mieru); Xray 3-step picker: protocol (VLESS/VMess/Trojan) → transport (raw/ws/grpc/xhttp/httpupgrade/kcp) → security (REALITY/TLS/none) + Generate-keypair button |
| `/squads` | SquadsPage | ACL groups: which profile is visible to which user group |
| `/subscription/metadata` | SubscriptionMetadataPage | Profile-Title / Update-Interval / Support-URL / Announce headers emitted on `/sub/:token` + routing preset picker (proxy-all / ru-split) |
| `/subscription/routing` | SrrPage | Subscription Response Rules CRUD + Test-against-UA panel (legacy `/srr` redirects here) |
| `/settings` | SettingsPage | Brand name, API tokens, regions |

## Develop

The backend must be running at `http://localhost:3000` (`pnpm --filter @iceslab/panel-backend dev` from the repo root).

```bash
pnpm --filter @iceslab/panel-frontend dev
# → http://localhost:5173
```

Same-origin in dev via CORS (the SPA hits `http://localhost:3000/api/...` directly; the backend whitelists the SPA origin).

## Type-check

```bash
pnpm --filter @iceslab/panel-frontend exec tsc --noEmit
```

The IDE TS-server occasionally lags on `/mnt/c` paths and shows phantom "Cannot find module" diagnostics; trust the CLI `tsc` over IDE squiggles.

## Production build

```bash
pnpm --filter @iceslab/panel-frontend build
# emits dist/ which the nginx Dockerfile picks up
```

The Dockerfile builds Vite and serves via `nginx:alpine` with a reverse-proxy config that forwards `/api`, `/sub`, `/health`, `/admin/` to the backend service in `docker-compose.prod.yml`. Single-origin in prod, no CORS.

## Tests

Three layers, cheapest first.

```sh
pnpm test        # vitest: locale parity + component tests (jsdom, no servers needed)
pnpm typecheck   # both projects: the app, and the tests + e2e
pnpm test:e2e    # playwright against a RUNNING panel (see below)
```

`pnpm test` and `pnpm typecheck` need nothing but the repo. `pnpm test:e2e`
drives a real browser against a real backend and database: start the panel
first (backend on `:3000`, this dev server on `:5173`), or point
`E2E_BASE_URL` / `E2E_API_URL` / `E2E_ADMIN_USER` / `E2E_ADMIN_PASS` elsewhere.
The first run downloads a chromium build (~115 MB) into `~/.cache/ms-playwright`.

The e2e suite runs one browser at a time on purpose, and it is meant to be run
**about once a minute**: the panel rate-limits login to 5/min and every route to
100/min per IP, and one full run is a sizeable fraction of that. A run inside
the window fails saying so by name rather than pretending the panel is broken.
Everything it creates is prefixed `e2e-` and deleted afterwards.
