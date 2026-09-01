import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FormatEnum, type Format } from './subscription.format-names.js';
import { ROUTING_PRESET_IDS, type RoutingPresetId } from '@iceslab/shared';
import * as service from './subscription.service.js';
import { buildClashYaml } from './formats/clash.js';
import { buildSingboxJson, type CustomGeoRef } from './formats/singbox.js';
import { buildWgQuickConf, wgConfName } from './formats/wgconf.js';
import { collectMtprotoNodes, collectWgNodes, tunnelConfigUrls } from './formats/per-node.js';
import { usableFormats } from './formats/format-usable.js';
import { buildAwgVpnLink } from './formats/amneziavpn.js';
import { buildXrayJson, buildXrayJsonArray } from './formats/xrayjson.js';
import { buildOutlineJson } from './formats/outline.js';
import { buildSurgeConf } from './formats/surge.js';
import { buildQuantumultXConf } from './formats/quantumultx.js';
import { buildLoonConf } from './formats/loon.js';
import { buildSubscriptionPage } from './formats/page.js';
import QRCode from 'qrcode-svg';
import { matchFormatForUserAgent } from '../srr/srr.service.js';
import {
  formatBytes,
  getSubscriptionSettings,
  renderAnnounce,
} from '../settings/settings.service.js';
import { enforceHwid, resolveSquadHwidLimit } from '../hwid/hwid.service.js';
import { prisma } from '../../prisma.js';
import { config, subscriptionOrigin } from '../../config.js';
import { geoArtifactBaseUrl } from '../geo/geo.url.js';
import { getCategoryDomains, getGeoBuildMeta } from '../geo/geo.registry.js';
import { GEO_MIRROR_SITE, GEO_MIRROR_IP } from '../geo/geo.orchestrator.js';
import { subscriptionRequests } from '../../lib/metrics.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/telegram-notify.js';
import { redis } from '../../lib/redis.js';
import { isPublicRoutableIp } from '../../lib/ip.js';

/**
 * Resolve `ext:<file>:<cat>` entries in an operator domain list into the custom
 * category's inline domains (xray matcher strings). Client subscriptions cannot
 * fetch a remote .dat, so a custom geo category is inlined here; xray-json uses
 * the matchers as-is and clash maps the prefixes to its rule types. An ext: ref
 * with no build / unknown category is dropped (a client cannot use it).
 */
function expandGeoRefs(list: string[]): string[] {
  const out: string[] = [];
  for (const d of list) {
    const m = /^ext:[A-Za-z0-9._-]+:(.+)$/.exec(d);
    if (!m) {
      out.push(d);
      continue;
    }
    const domains = getCategoryDomains(m[1]!);
    if (domains) out.push(...domains);
  }
  return out;
}

/**
 * The `ext:<file>:<cat>` custom-category refs in an operator domain list, as
 * {cat, bucket} for the sing-box format. sing-box cannot inline domains
 * (post-1.12), so instead of expandGeoRefs it references each custom category as
 * a self-hosted remote `.srs`. Plain (non-ext) entries have no sing-box vehicle
 * and are skipped (same as before this path existed).
 */
function geoRefCats(list: string[], bucket: CustomGeoRef['bucket']): CustomGeoRef[] {
  const out: CustomGeoRef[] = [];
  for (const d of list) {
    const m = /^ext:[A-Za-z0-9._-]+:(.+)$/.exec(d);
    if (m) out.push({ cat: m[1]!, bucket });
  }
  return out;
}

/**
 * G6 - self-hosted geo for the client formats. Non-null only when the flag is
 * on AND a build is cached: a rewritten geo URL the panel cannot serve (404)
 * bricks the client (sing-box refuses to start on a failed remote rule-set), so
 * the call sites also check per-artifact availability via `names`.
 */
function selfHostedGeo(): { base: string; names: Set<string> } | null {
  if (!config.GEO_SELF_HOST) return null;
  const meta = getGeoBuildMeta();
  if (!meta) return null;
  return { base: geoArtifactBaseUrl(), names: new Set(meta.artifacts.map((a) => a.name)) };
}

const TokenParamSchema = z.object({
  token: z.string().min(8).max(128),
});


const QuerySchema = z.object({
  format: FormatEnum.optional(),
  // Slice 29: outbound group flavour. Per-format semantics:
  //   sing-box   : 'selector' (default) | 'url-test'   (auto-failover)
  //   xray-json  : 'flat'     (default) | 'balancer'   (observatory+leastPing)
  //   clash      : already always emits url-test in its proxy-groups
  // We share one query param across formats because admins picking the
  // "smart auto-failover" form usually want it everywhere their clients
  // see it, not per-format.
  bundle: z.enum(['selector', 'url-test', 'flat', 'balancer']).optional(),
  // Slice 28: when set, cap subscription to top-N nodes ranked by region
  // match (CF-IPCountry) + current utilization. Default (omitted) keeps
  // legacy "return everything" behaviour so existing clients don't regress.
  // Capped at 32 to avoid pathological "give me 9999" requests.
  topN: z.coerce.number().int().min(1).max(32).optional(),
  // Routing Templates (R1a) - per-request override of the panel-wide
  // `subscriptionRoutingPreset` setting. Lets the admin smoke-test a preset
  // on one client before flipping it for everyone (same idea as `bundle`).
  // Only meaningful for full-config formats (clash/singbox/xrayjson).
  routing: z.enum(ROUTING_PRESET_IDS).optional(),
  // TLS-fragment - per-request override of the panel-wide
  // `subscriptionTlsFragment` setting (same idea as `?routing=`). `1` forces
  // it on, `0` forces it off. Only meaningful for the xrayjson format - the
  // fragment outbound + dialerProxy is an Xray-native technique.
  fragment: z.enum(['0', '1']).optional(),
  // Node selector for single-node formats (wgconf). wg-quick holds one tunnel
  // per file, so a user with several AmneziaWG nodes gets one link per node,
  // each pinned with `?node=<node name>`. Matched against the endpoint's
  // nodeName (unique among active nodes). Omitted = first AWG endpoint.
  node: z.string().min(1).max(64).optional(),
  // Flavour selector for wgconf. A node can serve an AmneziaWG tunnel and a
  // plain WireGuard one at once (separate interfaces, subnets and ports), and
  // they render to different files, so `?node=` alone is ambiguous there.
  // Omitted = first wg-family endpoint, whichever flavour.
  proto: z.enum(['amneziawg', 'wireguard']).optional(),
  // Which of the buyer's devices, by 1-based position or by device id. Every
  // device has its own keypair, so this picks a different tunnel, not a
  // different rendering of the same one. Omitted = the first, which is what a
  // single-device buyer and every pre-devices link get.
  device: z.string().min(1).max(64).optional(),
  // Human landing-page language override. The page renders an in-page RU/EN
  // selector that links here; it wins over the panel default and the
  // Accept-Language guess. Only meaningful for the HTML page.
  lang: z.enum(['ru', 'en']).optional(),
});

const FORMAT_VALUES: ReadonlySet<Format> = new Set(FormatEnum.options);

function isFormat(value: string): value is Format {
  return FORMAT_VALUES.has(value as Format);
}

/**
 * Resolve which format the client wants, in this priority order:
 *   1. Explicit `?format=` always wins.
 *   2. SRR (Subscription Response Rules): UA regex match against admin-
 *      defined rules in DB. Default seed rules cover Hiddify/Clash/v2rayN/
 *      sing-box/AmneziaWG-app + a `.*` catch-all → `plain`.
 *   3. Legacy Accept-header heuristic (`application/json` → `json`) for the
 *      IcePath-VPN bot integration that predates SRR.
 *   4. `plain` fallback (base64 URI list, universal).
 */
/**
 * Slice S1: set the subscription-metadata HTTP headers most VPN clients
 * read alongside the body. Conventions across Hiddify/V2RayNG/Streisand/
 * Happ/Mihomo:
 *
 *   Profile-Title              - display name in the client's profile list
 *   Profile-Update-Interval    - refresh cadence in HOURS (clients re-fetch
 *                                without admin intervention)
 *   Subscription-Userinfo      - `upload=N; download=N; total=N; expire=T`
 *                                (RFC-3339-ish), drives the quota gauge
 *   Support-URL                - clickable link in the profile detail page
 *   Announce                   - short banner shown to the user (rendered
 *                                template, supports {{TRAFFIC_LEFT}} etc.)
 *
 * Only well-formed values are emitted, admins can leave any setting NULL
 * to omit the corresponding header.
 */
async function applySubscriptionHeaders(
  reply: FastifyReply,
  user: {
    expireAt: string | null;
    trafficLimitBytes: number | null;
    trafficUsedBytes: number;
  },
): Promise<void> {
  const settings = await getSubscriptionSettings();

  const title = settings.profileTitle ?? settings.brandName;
  if (title) reply.header('Profile-Title', `base64:${Buffer.from(title, 'utf8').toString('base64')}`);
  reply.header('Profile-Update-Interval', String(settings.updateIntervalHours));
  if (settings.supportUrl) reply.header('Support-URL', settings.supportUrl);

  // Subscription-Userinfo. `upload+download === used`. We don't track
  // upload separately yet (per-user xray stats sum both directions),
  // so attribute everything to `download` and report `upload=0`, clients
  // sum them to derive used quota and the gauge stays correct.
  const used = Math.max(0, user.trafficUsedBytes);
  const total = user.trafficLimitBytes ?? 0;
  // expire is unix seconds; 0 = no expiry per de-facto convention.
  const expireUnix = user.expireAt
    ? Math.floor(new Date(user.expireAt).getTime() / 1000)
    : 0;
  reply.header(
    'Subscription-Userinfo',
    `upload=0; download=${used}; total=${total}; expire=${expireUnix}`,
  );

  // Announce: rendered template. Skip emission if template empty.
  if (settings.announceTemplate) {
    const trafficLeft =
      user.trafficLimitBytes === null
        ? '∞'
        : formatBytes(BigInt(Math.max(0, user.trafficLimitBytes - used)));
    const daysLeft =
      user.expireAt === null
        ? '∞'
        : String(
            Math.max(
              0,
              Math.ceil(
                (new Date(user.expireAt).getTime() - Date.now()) /
                  86400_000,
              ),
            ),
          );
    const announce = renderAnnounce(settings.announceTemplate, {
      trafficLeft,
      daysLeft,
      supportUrl: settings.supportUrl ?? '',
    });
    if (announce.length > 0) {
      // Some clients require base64 encoding for non-ASCII announce. We
      // emit both forms: Happ reads `Announce-URL`-style raw, Hiddify
      // base64. Stick with `Announce: base64:<...>` which both accept.
      reply.header(
        'Announce',
        `base64:${Buffer.from(announce, 'utf8').toString('base64')}`,
      );
    }
  }
}

async function resolveFormat(
  query: z.infer<typeof QuerySchema>,
  acceptHeader: string,
  userAgent: string | null,
): Promise<Format> {
  if (query.format) return query.format;
  const matched = await matchFormatForUserAgent(userAgent);
  if (matched && isFormat(matched)) return matched;
  if (acceptHeader.toLowerCase().includes('application/json')) return 'json';
  return 'plain';
}

// Wave-14 #6: a browser navigating to /sub/<token> should see a human page,
// not a base64 dump. Trigger on Accept: text/html with no explicit ?format,
// VPN clients send their own UA/Accept and never hit this. An explicit
// ?format= always wins (so `?format=plain` in a browser still returns raw).
function wantsHtmlPage(
  query: z.infer<typeof QuerySchema>,
  acceptHeader: string,
): boolean {
  if (query.format) return false;
  return acceptHeader.toLowerCase().includes('text/html');
}

function pickLang(acceptLanguage: string | undefined): 'ru' | 'en' {
  return (acceptLanguage ?? '').toLowerCase().includes('ru') ? 'ru' : 'en';
}

// Render a QR SVG for arbitrary text. Soft-fails to undefined (the page treats
// the QR as optional) so a too-large payload or any qrcode-svg edge never
// breaks the whole subscription page. `join` collapses modules into one path
// for a much smaller SVG. ecl=M balances density vs scan robustness.
function qrSvg(content: string, ecl: 'L' | 'M' | 'Q' | 'H' = 'M'): string | undefined {
  if (!content) return undefined;
  try {
    const svg = new QRCode({
      content,
      padding: 0,
      width: 160,
      height: 160,
      // ecl 'L' for long payloads (the AmneziaWG .conf with obfuscation params):
      // less error correction means fewer modules for the same data, so the QR
      // stays scannable at 160px instead of degrading into an unreadable mesh.
      ecl,
      join: true,
    }).svg();
    // qrcode-svg emits `<svg width="160" height="160">` with NO viewBox, so a
    // CSS width/height (e.g. the 300px vpn:// QR) resizes the viewport but NOT
    // the 160-unit drawing - the code ends up crammed in the top-left corner
    // with dead white space around it. Swap the svg tag's fixed size for a
    // viewBox so any CSS size scales the whole code uniformly. The non-greedy
    // capture stays inside the opening tag, leaving the 160x160 background
    // <rect> untouched. Also strip the `<?xml ...?>` prolog (noise inline).
    return svg
      .replace(/^<\?xml[^>]*\?>\s*/, '')
      .replace(/(<svg\b[^>]*?)\s*width="160"\s+height="160"/, '$1 viewBox="0 0 160 160"');
  } catch {
    return undefined;
  }
}

// Strip characters Content-Disposition can't legally carry to keep
// browsers happy across OSes. Username comes from admin-controlled
// input so paranoia is cheap; whitelist [a-zA-Z0-9._-], fold rest to
// underscore, cap length to keep filesystem-safe.
function sanitizeFilename(name: string): string {
  // Целая серия недопустимых символов схлопывается в ОДИН разделитель, а
  // ведущие и хвостовые снимаются. Посимвольная замена превращала имя ноды с
  // флагом (`\u{1F1F3}\u{1F1F1} s2`) в `_____s2` в имени каждого скачанного файла:
  // один эмодзи — это несколько кодовых единиц, и каждая давала своё
  // подчёркивание.
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'subscription';
}

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  // Secondary IP-only ceiling. The route's primary rate-limit is keyed on
  // (ip, token): legit, but an attacker rotates tokens to dodge it. This
  // hook caps total /sub hits per IP via a sliding Redis bucket, well
  // above legit shared-CGNAT polling so real users never feel it.
  async function ipRateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const ip = request.ip;
    const key = `sec:sub-ip:${ip}`;
    // Atomic INCR + (set TTL if first). Prior version did INCR then EXPIRE
    // in two round-trips, if the process crashed between them, the key
    // would live forever (until Redis maxmemory-policy evicted it). The
    // SET-NX-EX-1 below ensures TTL is established the moment the key
    // becomes non-empty, and ignored otherwise (NX). INCR then reads/bumps.
    await redis.set(key, '0', 'EX', 60, 'NX').catch(() => null);
    const count = await redis.incr(key).catch(() => 0);
    if (count > config.RATE_LIMIT_SUB_IP_PER_MIN) {
      reply.header('Retry-After', '60');
      return reply.code(429).send({
        error: 'RATE_LIMIT',
        message: 'Too many requests from this IP',
      });
    }
  }

  // GET /sub/:token - public (the token IS the credential).
  // Two-bucket rate-limit:
  //   - per-(ip,token) bucket caps a legit client's polling rate
  //   - per-(ip) bucket via ipRateLimitHook catches token-rotation
  // Path prefix is admin-configurable via SUBSCRIPTION_PATH_PREFIX env
  // (default `/sub`). Lets operators mask Iceslab signature on the
  // wire, e.g. `/v` so user links look like https://panel/v/<token>.
  app.get(`${config.SUBSCRIPTION_PATH_PREFIX}/:token`, {
    onRequest: [ipRateLimitHook],
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_SUB_PER_MIN,
        timeWindow: '1 minute',
        // Per-token bucket so one client polling on the same token doesn't
        // share rate-budget with unrelated subscriptions on shared CGNAT.
        keyGenerator: (req) => {
          const t = (req.params as { token?: string })?.token ?? 'unknown';
          return `${req.ip}:${t}`;
        },
      },
    },
  }, async (request, reply) => {
    const params = TokenParamSchema.parse(request.params);
    const query = QuerySchema.parse(request.query);
    const userAgent = typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent']
      : null;
    const format = await resolveFormat(
      query,
      (request.headers.accept ?? '').toString(),
      userAgent,
    );
    subscriptionRequests.inc({ format });

    // Tier-1 honey-user tripwire. If the requested token is on the admin's
    // canary list, the token by definition was leaked from where it was
    // planted (pastebin, screenshot, dropped USB, …). Alert immediately,
    // blacklist the source IP (same Redis key as the path-honeypot), and
    // return a plausible-empty 200, making the attacker believe their
    // exfiltrated token is "just empty subscription" instead of "this is
    // a panel that knows it was leaked."
    if (config.HONEY_USER_TOKENS.includes(params.token)) {
      const ip = request.ip;
      const ttl = config.HONEYPOT_BLACKLIST_TTL_SEC;
      // Only blacklist real public IPs. If TRUST_PROXY_HOPS is misconfigured
      // an attacker can spoof X-Forwarded-For with a private/loopback IP and
      // get arbitrary legit users DoS'd via this honeypot. Skip the blacklist
      // for any IP we can identify as non-routable; still alert + return empty.
      if (isPublicRoutableIp(ip)) {
        await redis.set(`sec:blacklist:${ip}`, '1', 'EX', ttl, 'NX').catch(() => null);
      }
      notifyTelegramAsync(
        `🪤 *Honey-user token used*\nip: \`${escapeMarkdown(ip)}\`\nua: \`${escapeMarkdown(userAgent ?? '?')}\`\nformat: \`${format}\`\ntoken: \`${escapeMarkdown(params.token.slice(0, 6))}...\``,
      );
      // Plausible empty subscription. Mirror the same content-type the
      // legit path would use for `?format=plain`.
      reply.type('text/plain; charset=utf-8');
      return reply.send('');
    }

    try {
      // Slice S2: HWID enforcement runs BEFORE generateSubscription so
      // a denied client doesn't burn a subscription_request_history row
      // or stress the binding query. Cost is one cheap user lookup.
      const hwidHeader = request.headers['x-hwid'];
      const hwid =
        typeof hwidHeader === 'string' && hwidHeader.length > 0 && hwidHeader.length <= 255
          ? hwidHeader
          : null;
      const userMin = await prisma.user.findFirst({
        where: { subscriptionToken: params.token, deletedAt: null },
        select: {
          id: true,
          hwidDeviceLimit: true,
          // K7 - the user's squads' HWID-limit defaults (used when the user has
          // no explicit limit).
          groupMembers: { select: { group: { select: { hwidDeviceLimit: true } } } },
        },
      });
      if (userMin) {
        // K7 - explicit per-user limit wins; otherwise fall back to the
        // most-permissive squad default.
        const effectiveHwidLimit =
          userMin.hwidDeviceLimit ??
          resolveSquadHwidLimit(userMin.groupMembers.map((m) => m.group.hwidDeviceLimit));
        // Remnawave-compat: capture client-reported device metadata from the
        // subscription-client headers (bounded, like x-hwid) so /hwid/devices
        // can surface platform/os/model. Non-Remnawave clients omit them → null.
        const readDeviceHeader = (name: string, max: number): string | null => {
          const v = request.headers[name];
          const s = typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
          const t = (s ?? '').trim();
          return t.length > 0 ? t.slice(0, max) : null;
        };
        const deviceMeta = {
          platform: readDeviceHeader('x-device-os', 64),
          osVersion: readDeviceHeader('x-ver-os', 64),
          deviceModel: readDeviceHeader('x-device-model', 128),
          userAgent: userAgent ? userAgent.slice(0, 512) : null,
        };
        const hwidResult = await enforceHwid(userMin.id, hwid, effectiveHwidLimit, deviceMeta);
        // Always emit the gauge header so the client can render "2/3" in
        // its profile detail UI, even on success, even when no limit set.
        // HTTP headers are ISO-8859-1; use ASCII-only "unlimited" instead
        // of '∞' which throws on the wire.
        if (hwidResult.limit !== null) {
          reply.header(
            'X-Hwid-Active',
            `${hwidResult.active}/${hwidResult.limit}`,
          );
        } else {
          reply.header(
            'X-Hwid-Active',
            `${hwidResult.active}/unlimited`,
          );
        }
        if (hwidResult.status === 'denied') {
          // 403 with a structured body, clients that don't read headers
          // still get a parseable reason.
          return reply.code(403).send({
            error: 'HWID_LIMIT',
            message: `Device limit reached (${hwidResult.active}/${hwidResult.limit})`,
            active: hwidResult.active,
            limit: hwidResult.limit,
          });
        }
      }

      // CF-IPCountry forwarded into the service so the smart-selection
      // ranker (slice 28) can score nodes by region match. Falls back to
      // `X-Country-Code` for non-Cloudflare deployments where the edge
      // sets its own header.
      const cfCountryRaw = (request.headers['cf-ipcountry'] ??
        request.headers['x-country-code']) as string | string[] | undefined;
      const cfCountry = Array.isArray(cfCountryRaw) ? cfCountryRaw[0] : cfCountryRaw;
      const result = await service.generateSubscription(params.token, {
        ip: request.ip,
        userAgent,
        topN: query.topN,
        cfCountry,
      });

      // Slice 30: host-level format gating. Each endpoint carries an
      // optional `disableForFormats[]` from its originating host row; we
      // filter before invoking the format-specific formatter so each
      // formatter can stay agnostic of host presence.
      const filtered = result.endpoints.filter(
        (e) => !(e.disableForFormats ?? []).includes(format),
      );
      const filteredPlain = result.endpoints
        .filter((e) => !(e.disableForFormats ?? []).includes('plain'))
        // A4: a balancer-cascade entry expands into one re-tagged URI per exit;
        // other endpoints pass through. (This note used to claim the JSON array
        // is not pingable in Happ. It is - checked in the field 2026-08-16 - and
        // the claim had been steering design decisions.)
        .flatMap((e) => service.expandEndpointUris(e));

      // Slice S1: emit subscription-metadata HTTP headers every client
      // app reads to set its profile name, refresh interval, quota gauge,
      // support link, and announce banner. Done after generateSubscription
      // so we have the user's traffic/expire snapshot.
      await applySubscriptionHeaders(reply, result.json.user);

      // Wave-14 #6: browser navigation → human-readable landing page instead
      // of the base64 `plain` dump. Uses the same generated data; emits no
      // config, just links + copy + per-format download buttons.
      // A person, not a client. Where they belong is a product decision: this
      // panel is an internal tool that happens to sit in the external
      // perimeter, and the human side of the product is the shop. So when the
      // operator has named a portal, a browser goes there and only the CLIENT
      // keeps talking to us.
      //
      // Before the page, because the page is what we are replacing. After the
      // `?format=` check inside wantsHtmlPage, because an explicit format is
      // someone asking for a config on purpose - including our own admin UI
      // and every debugging curl - and redirecting that would break the thing
      // the redirect is meant to leave alone.
      //
      // 302, not 301: which surface serves people is an operational choice, and
      // a permanent redirect is cached by browsers past the point where the
      // operator can change their mind.
      if (
        config.CLIENT_PORTAL_URL &&
        wantsHtmlPage(query, (request.headers.accept ?? '').toString())
      ) {
        return reply.redirect(config.CLIENT_PORTAL_URL, 302);
      }
      if (wantsHtmlPage(query, (request.headers.accept ?? '').toString())) {
        const settings = await getSubscriptionSettings();
        const subUrl = `${subscriptionOrigin()}${config.SUBSCRIPTION_PATH_PREFIX}/${params.token}`;
        const protocols = [...new Set(result.endpoints.map((e) => e.protocol))];
        // One QR pair per AmneziaWG node. wg-quick / vpn:// are
        // single-tunnel-per-key, so a user with several AWG servers gets each
        // server's own labelled QR (.conf for the AmneziaWG app, vpn:// for the
        // AmneziaVPN app) instead of only the first node's. ecl 'L' keeps the
        // long payloads scannable. Plain WireGuard gets the same minus the
        // vpn:// key: its clients import the .conf (or its QR) and nothing else.
        //
        // The node walk itself lives in collectWgNodes so the shop's install
        // screen offers the same servers, in the same order, as this page.
        //
        // Filtered by `wgconf`, NOT by `format`. `format` here is whatever the
        // request resolved to, and for a browser that is `plain` — a different
        // question from the one these cards answer. Every one of them leads to
        // `?format=wgconf`, so a host the admin switched off for wgconf must
        // drop out; filtering by `plain` instead left the download button on the
        // page and the download itself empty (measured 2026-08-26: 341 bytes
        // before the switch, 0 after, button unmoved).
        const wgVisible = result.endpoints.filter(
          (e) => !(e.disableForFormats ?? []).includes('wgconf'),
        );
        const brand = settings.profileTitle ?? settings.brandName ?? result.json.user.username;
        const awgNodes = collectWgNodes(wgVisible, 'amneziawg', {
          dns: settings.wgDns,
          brand,
        }).map((n) => ({
          nodeName: n.nodeName,
          deviceIndex: n.deviceIndex,
          confQrSvg: n.conf ? qrSvg(n.conf, 'L') : undefined,
          vpnQrSvg: n.vpnKey ? qrSvg(n.vpnKey, 'L') : undefined,
          // Raw vpn:// key for a copy button: the AmneziaVPN key QR is dense
          // enough to be unreliable on screen, so paste-the-key is the robust path.
          vpnKey: n.vpnKey ?? undefined,
        }));
        const wgNodes = collectWgNodes(wgVisible, 'wireguard', { dns: settings.wgDns, brand }).map((n) => ({
          nodeName: n.nodeName,
          deviceIndex: n.deviceIndex,
          confQrSvg: n.conf ? qrSvg(n.conf, 'L') : undefined,
        }));
        return reply.type('text/html; charset=utf-8').send(
          buildSubscriptionPage({
            brandTitle: settings.profileTitle ?? settings.brandName ?? 'Iceslab',
            // Language priority: in-page ?lang selector (per visitor) > panel
            // default (mirrored from the operator's UI language) > the visitor's
            // Accept-Language guess.
            lang:
              query.lang ??
              settings.defaultLocale ??
              pickLang(request.headers['accept-language'] as string | undefined),
            subUrl,
            supportUrl: settings.supportUrl,
            user: result.json.user,
            protocols,
            subUrlQrSvg: qrSvg(subUrl),
            awgNodes,
            wgNodes,
            // Not format-gated: the t.me link is built from the endpoint and
            // fetches nothing back from us.
            mtprotoNodes: collectMtprotoNodes(result.endpoints),
            usableFormats: usableFormats(result.endpoints),
          }),
        );
      }

      // Routing Templates - resolve the preset only for full-config formats.
      // Precedence (R1a + R3-a + R3): `?routing=` query wins, then the user's
      // per-user override, then their per-squad override, then the panel-wide
      // setting. plain/json/wgconf carry no routing section, so we skip the
      // read there.
      let routingPreset: RoutingPresetId = 'proxy-all';
      let customRoutingRules: Record<string, unknown>[] | undefined;
      // R3 - operator-defined custom domain lists (direct/proxy/block), emitted
      // into xray + clash routing rules. Undefined = none = byte-identical.
      let customDomainLists: { direct: string[]; proxy: string[]; block: string[] } | undefined;
      // sing-box custom-category refs (ext:) captured BEFORE the xray/clash
      // inline-expansion below overwrites customDomainLists with plain domains.
      let singboxGeoRefs: CustomGeoRef[] | undefined;
      // TLS-fragment - `?fragment=` query wins, else the panel-wide setting.
      // Only the xrayjson format reads this (the fragment outbound + dialerProxy
      // is Xray-native); clash/singbox ignore it.
      let tlsFragment = false;
      if (
        format === 'clash' ||
        format === 'singbox' ||
        format === 'xrayjson' ||
        format === 'xrayjson-array' ||
        format === 'xkeen'
      ) {
        const settings = await getSubscriptionSettings();
        routingPreset =
          query.routing ??
          result.userRoutingPreset ??
          result.squadRoutingPreset ??
          settings.routingPreset;
        // R3-b custom rules apply only to xray-routing formats (xray/xkeen).
        customRoutingRules = settings.customRoutingRules ?? undefined;
        // R3 custom domain lists apply to xray/xkeen + clash. Expand any
        // ext:<file>:<cat> refs into the custom category's inline domains.
        customDomainLists = settings.customDomainLists ?? undefined;
        if (customDomainLists) {
          // Capture ext: custom-category refs for sing-box (self-hosted .srs)
          // BEFORE inlining them into plain domains for xray/clash. Order
          // block -> direct -> proxy so a category listed in two buckets resolves
          // the same (block wins, first-match) as the xray/clash formats
          // (xrayjson/clash emit block, then direct, then proxy) - otherwise
          // sing-box would silently let a blocked category through direct.
          singboxGeoRefs = [
            ...geoRefCats(customDomainLists.block, 'block'),
            ...geoRefCats(customDomainLists.direct, 'direct'),
            ...geoRefCats(customDomainLists.proxy, 'proxy'),
          ];
          customDomainLists = {
            direct: expandGeoRefs(customDomainLists.direct),
            proxy: expandGeoRefs(customDomainLists.proxy),
            block: expandGeoRefs(customDomainLists.block),
          };
        }
        tlsFragment =
          query.fragment !== undefined ? query.fragment === '1' : settings.tlsFragment;
      }

      const geo = selfHostedGeo();

      switch (format) {
        case 'json': {
          // An endpoint with no share-link (both WireGuard flavours) carries
          // `uri: ''`, which tells a reader nothing about how to connect. Name
          // the per-node files it does have instead — the same URLs the install
          // surfaces put behind their download buttons.
          const subUrl = `${subscriptionOrigin()}${config.SUBSCRIPTION_PATH_PREFIX}/${params.token}`;
          return reply.type('application/json').send({
            ...result.json,
            endpoints: filtered.map((e) => {
              const configUrls = tunnelConfigUrls(e, subUrl);
              return configUrls ? { ...e, configUrls } : e;
            }),
          });
        }
        case 'clash':
          return reply
            .type('text/yaml; charset=utf-8')
            .send(
              buildClashYaml(filtered, {
                routingPreset,
                customDomainLists,
                // Clash points geox-url at BOTH mirror .dat; only rewrite when
                // the build produced both, else keep the external default.
                geoBaseUrl:
                  geo?.names.has(GEO_MIRROR_SITE) && geo.names.has(GEO_MIRROR_IP)
                    ? geo.base
                    : undefined,
              }),
            );
        case 'singbox': {
          // TLS-fragment is intentionally NOT emitted for sing-box: the
          // upstream field is unstable across 1.12/1.14 (same rationale as the
          // skipped sing-box DNS split in R2). Xray JSON only.
          // Map shared bundle param to singbox values. 'flat' / 'balancer'
          // are xray-specific; in sing-box context they mean the default
          // selector form.
          const sbBundle: 'selector' | 'url-test' | undefined =
            query.bundle === 'url-test' || query.bundle === 'selector'
              ? query.bundle
              : undefined;
          return reply
            .type('application/json')
            .send(
              buildSingboxJson(filtered, {
                bundle: sbBundle,
                routingPreset,
                geoBaseUrl: geo?.base,
                geoArtifacts: geo?.names,
                customGeoRefs: singboxGeoRefs,
              }),
            );
        }
        case 'wgconf': {
          const wgSettings = await getSubscriptionSettings();
          // Filename = `<brand>-<node>-<flavour>.conf`. The node and flavour
          // parts keep several tunnels apart (the browser otherwise saves
          // test.conf, test(1).conf, ...), and the `.conf` suffix matters: the
          // AmneziaWG / wg-quick / Hiddify file-pickers filter by *.conf, so an
          // extensionless name fails the picker on Windows / macOS.
          //
          // The brand leads instead of the username because THIS STRING IS THE
          // TUNNEL NAME the buyer sees: wg-quick has no name field, so every
          // importing client falls back to the file name — and where it can't
          // read one, to the endpoint address. `tg_245073332` told the buyer
          // nothing; a bare IP told them less.
          // The device's position rides in the name so a buyer with three
          // tunnels to one server can tell them apart in the client list -
          // where wg-quick gives them nothing else to go on.
          const deviceIndex = Number(query.device);
          const tunnelName = wgConfName(
            wgSettings.profileTitle ?? wgSettings.brandName ?? result.json.user.username,
            query.node,
            query.proto,
            Number.isInteger(deviceIndex) ? deviceIndex : undefined,
          );
          return reply
            // Не `text/plain`, хотя тело — текст. Android по MIME-типу
            // ДОСТРАИВАЕТ расширение: для `text/plain` он видит незнакомое
            // `.conf` и дописывает своё, получается `OneginVPN-wg.conf.txt`.
            // А файловые пикеры WireGuard, AmneziaWG и wg-quick фильтруют по
            // `*.conf` — скачанный файл в списке просто не виден, и клиент,
            // которому его всё же скормили, зовёт конфиг некорректным.
            // `application/octet-stream` расширения не имеет вовсе, поэтому
            // имя из Content-Disposition доезжает как есть. Тело не меняется:
            // клиенты, читающие ответ как текст (импорт по ссылке), разницы
            // не заметят — charset остаётся в заголовке.
            .type('application/octet-stream; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${tunnelName}.conf"`)
            .send(
              buildWgQuickConf(filtered, query.node, query.proto, {
                dns: wgSettings.wgDns,
                device: query.device,
                // Имя дублируется внутрь файла, потому что импорт по ССЫЛКЕ
                // заголовок Content-Disposition не читает вовсе: WG Tunnel
                // качает тело и отдаёт его в тот же путь, что и вставку из
                // буфера, а имя там берётся из `# Name =` либо, если его нет,
                // из хоста в Endpoint — то есть из голого IP.
                name: tunnelName,
              }),
            );
        }
        case 'amneziavpn': {
          // AmneziaVPN-app "vpn://" connection key (base64 blob the flagship
          // AmneziaVPN clients import directly: their QR scanner and "paste
          // key" both accept it). Single tunnel per key, so `?node=` selects
          // which AmneziaWG node; absent = first. Empty body = no AWG endpoint
          // for this user (same 204-style contract as wgconf).
          return reply
            .type('text/plain; charset=utf-8')
            .send(
              buildAwgVpnLink(
                filtered,
                query.node,
                (await getSubscriptionSettings()).wgDns,
                query.device,
              ),
            );
        }
        case 'xrayjson': {
          const xjBundle: 'flat' | 'balancer' | undefined =
            query.bundle === 'balancer' || query.bundle === 'flat'
              ? query.bundle
              : undefined;
          return reply
            .type('application/json')
            .send(buildXrayJson(filtered, { bundle: xjBundle, routingPreset, customRules: customRoutingRules, customDomainLists, tlsFragment }));
        }
        case 'xrayjson-array': {
          // A1: top-level JSON array of standalone xray configs (one per
          // endpoint), the shape Happ / V2RayTun parse as N separate servers.
          // Carries the same routing surface as single-config xrayjson, minus
          // `bundle` (no balancer: the client picks a server, not an outbound).
          return reply
            .type('application/json')
            .send(buildXrayJsonArray(filtered, { routingPreset, customRules: customRoutingRules, customDomainLists, tlsFragment }));
        }
        case 'xkeen': {
          // XKeen (xray-core on Keenetic routers): outbounds + routing +
          // split-DNS, NO client inbound (router provides tproxy). Drop-in for
          // confdir 04_outbounds / 05_routing (+ 02_dns). routingPreset is
          // resolved above (defaults to the panel/squad RU-split when set).
          const xkBundle: 'flat' | 'balancer' | undefined =
            query.bundle === 'balancer' || query.bundle === 'flat'
              ? query.bundle
              : undefined;
          return reply
            .type('application/json')
            .header(
              'Content-Disposition',
              `attachment; filename="${sanitizeFilename(result.json.user.username)}-xkeen.json"`,
            )
            .send(buildXrayJson(filtered, { bundle: xkBundle, routingPreset, forRouter: true, customRules: customRoutingRules, customDomainLists }));
        }
        case 'outline':
          // SIP008 Shadowsocks online-config (Outline / shadowsocks-* clients).
          // SS-only; non-SS endpoints are skipped inside the builder.
          return reply
            .type('application/json')
            .send(buildOutlineJson(filtered));
        case 'surge':
          // Surge [Proxy] lines. ss/vmess/trojan/hy2; no vless/REALITY.
          return reply.type('text/plain; charset=utf-8').send(buildSurgeConf(filtered));
        case 'quantumultx':
          // Quantumult X server_local lines. ss/vmess/vless/trojan incl REALITY.
          return reply.type('text/plain; charset=utf-8').send(buildQuantumultXConf(filtered));
        case 'loon':
          // Loon proxy lines (best-effort; verify import in-app). ss/vmess/vless/
          // trojan/hy2 incl REALITY.
          return reply.type('text/plain; charset=utf-8').send(buildLoonConf(filtered));
        case 'plain':
        default:
          return reply
            .type('text/plain; charset=utf-8')
            .send(Buffer.from(filteredPlain.filter((u) => u.length > 0).join('\n'), 'utf8').toString('base64'));
      }
    } catch (err) {
      if (err instanceof service.SubscriptionNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof service.SubscriptionForbiddenError) {
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: err.message,
          reason: err.reason,
        });
      }
      throw err;
    }
  });
}
