# geo-svc production-readiness — live validation checklist

The `feat/geo-svc` prod-hardening changes are **code-complete and green** (backend/frontend
`tsc`, `vitest` 713 passed, `go build/vet/test`). Everything is off-by-default
(`GEO_SELF_HOST=false`, `egressPolicy` NULL, `SINGBOX_BIN` unset → byte-identical output).

What CANNOT be proven in the dev sandbox and must be checked on the live rig before relying on
geo-split / self-hosted geo in production. Rig: panel `pntest.stdfo.com`
(`root@194.67.92.130`), node `s1` (`root@130.49.150.169`, Debian 13, xray 26.3.27, behind RU
DPI). Deploy the fork the usual way (tar+scp+`compose build backend && up -d backend`; rebuild
the node agent `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build` + scp).

---

## 1. §3.1 — IPOnDemand geoip split on the entry (the risky one)

The panel now sets `domainStrategy: 'IPOnDemand'` on a geo-split entry whose policy has a
geoip/ip matcher (was `IPIfNonMatch`, under which geoip rules were dead for sniffed traffic).
This touches the entry node's **global** routing resolution — validate before trusting it.

- [ ] Create a cascade with `egressPolicy: [{ geoip: ['ru'], target: 'direct' }]`; confirm the
      rendered node config has `routing.domainStrategy: "IPOnDemand"` (`journalctl`/config dump).
- [ ] Drive real RU + non-RU TLS traffic through the entry; confirm RU-geoip destinations
      egress `direct` and the rest ride the link-out. (geosite/domain splits already worked.)
- [ ] **CDN caveat:** IPOnDemand resolves the *sniffed domain* via the node's DNS, which can
      return a **different IP** than the client connects to (CDN / geo-DNS). Spot-check a
      CDN-fronted RU domain — is the geoip match accurate enough? If not, prefer `geosite:`.
- [ ] Confirm a plain cascade and a balancer entry are **not destabilized** (latency, no
      restart loops) — the strategy is global to that node's xray.
- [ ] Confirm a geosite/domain-only policy still renders **no** `domainStrategy` override
      (byte-identical to before).

## 2. §3.2 — category safety (the outage-prevention one)

Node now runs `xray -test` on a candidate config before swapping; the panel rejects the two
high-signal authoring mistakes up front.

- [ ] On s1, author a cascade referencing a **nonexistent** bare `geosite:` category (one not
      in the node's bundled `geosite.dat`). Confirm: the node logs `xray rejected the config
      (run -test): ... category not found`, **refuses the swap, and the old xray keeps
      serving** (no restart storm, entry stays up). This is the load-bearing safety net.
- [ ] Confirm the panel rejects (400) a custom category used as a bare `geosite:`/`geoip:`, and
      an unknown `geoip:` code (typo).
- [ ] **Reconcile the embedded geoip allowlist:** dump the node's actual bundle vocabulary and
      compare with `GEOIP_CATEGORIES` in `apps/panel-backend/src/modules/cascades/cascade.geo.stock.ts`.
      If the node bundles a non-default `geoip.dat` with extra/fewer categories, update the set.
      (Rough dump: on s1, inspect `/usr/local/share/xray/geoip.dat` — or route a test policy
      per code and observe which `geoip:` names `xray -test` accepts.)

## 3. §3.5 / §3.8 — sing-box custom `.srs` + compatibility

- [ ] With `GEO_SELF_HOST=true` + `SINGBOX_BIN` set, define a custom category and reference it
      in the subscription's custom domain lists; fetch `?format=singbox` and confirm it carries
      a `{type:'remote', tag:'custom-<cat>', url:'…/custom-<cat>.srs'}` rule_set + a
      bucket-mapped route rule, and that `custom-<cat>.srs` serves 200 at `/geo/<token>/…`.
- [ ] **`.srs` version compat:** load the panel's `.srs` (compiled by sing-box 1.11.4) in real
      sing-box **1.12** and **1.14** clients — does the rule-set load and match? (Backward-format
      direction is favorable but unverified in-repo.) If a client rejects it, bump
      `SINGBOX_VERSION` in `apps/panel-backend/Dockerfile` to a version those clients read — and
      **update both `SINGBOX_SHA256_*` ARGs** (the build's `sha256sum -c` fails otherwise; get
      the checksums from the release).
- [ ] Confirm the image builds with the pinned checksums (`docker build` of the panel image).

## 4. §3.3 — build lifecycle propagation

- [ ] Set up an egress cascade referencing a custom `ext:` category (self-host on). Restart the
      panel; confirm the entry node is **re-pushed** (`cascade.changed`) once the warm-up build
      lands, and its policy comes back with the `ext:` matchers intact (not silently stripped).
- [ ] Edit a custom category → `POST /api/geo/build`; confirm the changed `.dat` reaches the
      entry node (new sha in `geoAssets`) without an unrelated no-op rebuild thrashing nodes.

## 5. §3.4 / §3.9 / §раздача — fetch + serving

- [ ] Confirm a real GitHub-release geo URL (302 → CDN) still downloads through the panel's
      manual-redirect path (per-hop SSRF re-check didn't break the legit redirect).
- [ ] Confirm the node recovers a geo fetch across a transient CDN flap (retry+backoff) instead
      of staying on stale/bundled geo. (The node fetch now fails a blackholed host fast — ~10s
      dial timeout per attempt — under a shared ~60s total budget, so a stuck geo host can't
      hold the adapter's restart lock for minutes.)
- [ ] **Confirm the front proxy passes `/geo/` to the backend.** pntest uses Caddy
      (`reverse_proxy 127.0.0.1:8080`), which forwards everything — so `/geo/<token>/<name>`
      should reach the backend. (The bundled compose `nginx.conf` has **no** `/geo/` location and
      would send it to the SPA fallback — do NOT front geo with that nginx as-is.) Verify a
      client actually fetches the geo `.dat`/`.srs`, and that a conditional GET returns **304**.

---

## Residual gaps (known, non-blocking)

- **adapter.go geo-apply race tests** (`regenFailed`/`stopGen` under concurrent Stop/Apply)
  remain unwritten — this is *pre-existing* untested concurrency, not introduced by these
  changes. The new `xray -test` preflight has direct + one integration test; the surrounding
  race logic is exercised only indirectly. Worth a dedicated concurrency test before scale.
- **DNS-rebind** is still not caught by the geo-fetch SSRF guard (a public name resolving to a
  private IP passes) — same accepted admin-trusted limitation as `recipes.ssrf`. Full closure =
  resolve-then-pin-IP, deferred.
- **Public `/geo/` load** at high client counts is RAM-served (zero-copy) with `max-age=3600` +
  304 revalidation; a dedicated reverse-proxy cache (`B` option) is deferred until the client
  base grows.
- **Multi-replica**: the in-process build cache assumes single-replica (prod is — one `backend`
  service, fixed `container_name`). Do not scale the backend horizontally with `GEO_SELF_HOST`
  on without moving the cache to shared storage.
