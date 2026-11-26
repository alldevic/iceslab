# Panel-side Core Adapters

Per-protocol modules that build client-facing subscription wire formats (URIs and config blobs the user pastes into their VPN client). Each subdirectory mirrors a Go-side `apps/node/internal/core/<protocol>/` adapter that handles the server-facing lifecycle of the same protocol.

## Current adapters

| Folder | Wire format it builds |
|---|---|
| [`hysteria/`](./hysteria/) | `hysteria2://...` URI |
| [`xray/`](./xray/) | `vless://...` (VLESS + REALITY + Vision); transports raw / xhttp / ws / gRPC / httpupgrade / kcp; Trojan over REALITY |
| [`amneziawg/`](./amneziawg/) | wg-quick `[Interface]+[Peer]` text, with the Jc/S/H obfuscation block |
| [`wireguard/`](./wireguard/) | the same text without it, for stock WireGuard clients |
| [`naive/`](./naive/) | `naive+https://user:pass@host:port?padding=true#name` URI |
| [`shadowsocks/`](./shadowsocks/) | SIP002 `ss://...` URI |
| [`mtproto/`](./mtproto/) | `tg://proxy?...` + `https://t.me/proxy?...` |
| [`mieru/`](./mieru/) | JSON profile + `mieru://...` URI |

Each module exports a `build<Protocol>Uri(...)` function (or `buildAmneziawgClientConfig` for the WG case where there's no URL form).

## How they're orchestrated

The subscription generator at [`../subscription/`](../subscription/) is a thin fan-out: it iterates the user's enabled inbounds, calls the matching builder, and the route handler glues the output into the requested wire format.

```
inbounds (DB) ─► subscription.service.ts ─► [per-protocol builders] ─► structured endpoints
                                                                       │
                                                                       ├─► encodePlainList ─► base64
                                                                       ├─► clash.ts        ─► YAML
                                                                       ├─► singbox.ts      ─► JSON
                                                                       ├─► wgconf.ts       ─► .conf
                                                                       └─► xrayjson.ts     ─► JSON
```

## Adding a new wire format

1. Decide whether it's URI-style or full-config. URI builders go in `<protocol>/uri.ts` (see Xray for the canonical example). Config builders go in `<protocol>/<format>.ts` next to it.
2. Update the `SubscriptionEndpoint` discriminated union in [`../subscription/subscription.formats.ts`](../subscription/subscription.formats.ts) if the new format needs structured fields the existing union doesn't carry.
3. Wire the builder into [`../subscription/formats/`](../subscription/formats/) if it's a format-level aggregator (Clash YAML, Sing-box JSON) rather than a per-protocol URI.
4. Add a route case in [`../subscription/subscription.routes.ts`](../subscription/subscription.routes.ts) if the new format gets its own `?format=` value.
5. Tests next to the builder. Add a route-level test that verifies the `Content-Type` and body shape end-to-end.
