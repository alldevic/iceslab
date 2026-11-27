import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { request } from 'undici';
import { requireAuth } from '../auth/auth.hook.js';
import { prisma } from '../../prisma.js';
import { redis } from '../../lib/infra/redis.js';
import { config, subscriptionOrigin } from '../../config.js';
import { buildSubscriptionPage } from '../subscription/subscription.page.js';
import {
  getSubscriptionSettings,
  invalidateSubscriptionSettingsCache,
} from './settings.service.js';
import { UpdateSettingsSchema } from './settings.schemas.js';
import { readCapped, subscriptionProbeAnswered } from './settings.probe.js';
import { planDnsTransfer, pushDnsNodes, RoutingPresetDnsConflictError, RoutingPresetDnsLimitError, writeDnsPlan, type NodeDnsPlan } from '../routing-presets/routing-presets.nodes.js';
import { checkDnsRules, RoutingPresetRulesError } from '../routing-presets/routing-presets.rules.js';
import { audit } from '../audit/audit.hook.js';

/** JSON with object keys sorted: jsonb hands an object back in its own key
 *  order, so a plain stringify would call an unchanged object changed. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

/**
 * When the certificate on that address runs out, or null when there is none
 * to read (plain http, or a handshake that never completed).
 *
 * Read with a bare TLS handshake rather than from the HTTP response: undici
 * does not hand back the peer certificate, and the operator's question here
 * ("is this going to expire on me") is worth its own five seconds.
 */
async function peerCertificateExpiry(url: string): Promise<string | null> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return null;
  return new Promise((resolve) => {
    const socket = tlsConnect(
      {
        host: parsed.hostname,
        port: Number(parsed.port || 443),
        servername: parsed.hostname,
        // A self-signed or mismatched certificate still has an expiry, and
        // saying when it runs out is more useful than refusing to look.
        rejectUnauthorized: false,
        timeout: 5000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const to = cert && typeof cert.valid_to === 'string' ? new Date(cert.valid_to) : null;
        resolve(to && !Number.isNaN(to.getTime()) ? to.toISOString() : null);
      },
    );
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * Panel-wide settings (brand name, future feature flags). Two surfaces:
 *
 *   GET /api/settings/public: no auth, returns public-flagged keys
 *                                only. LoginPage fetches this before the
 *                                user authenticates so the page can show
 *                                the right brand.
 *
 *   GET /api/settings: requireAuth, returns ALL keys
 *   PUT /api/settings: requireAuth, upsert keys
 *
 * Keys we use today:
 *   - `brandName` (string, public): title shown on LoginPage + sidebar
 *   - `subscriptionProfileTitle` (string): Profile-Title header on /sub
 *                                                   (NULL → fall back to brandName)
 *   - `subscriptionUpdateIntervalHours` (number): Profile-Update-Interval header,
 *                                                   default 24
 *   - `subscriptionSupportUrl` (string): Support-URL header + announce
 *                                                   {{SUPPORT_URL}} placeholder
 *   - `subscriptionAnnounceTemplate` (string): Announce header template,
 *                                                   placeholders: {{TRAFFIC_LEFT}},
 *                                                   {{DAYS_LEFT}}, {{SUPPORT_URL}}
 *   - `subscriptionRoutingPreset` (enum, R1a + H2) - routing rules emitted into
 *                                                   clash/singbox/xrayjson:
 *                                                   'proxy-all' (default) |
 *                                                   'ru-split' | 'cn-split'
 *   - `subscriptionTlsFragment` (boolean)         - when true, the Xray JSON
 *                                                   format splits the client's
 *                                                   outgoing ClientHello via a
 *                                                   freedom `fragment` outbound
 *                                                   so SNI-based DPI cannot
 *                                                   cleanly match the handshake.
 *                                                   Default false. Xray JSON only.
 *   - `subscriptionDnsRules` (DnsRule[], stage 19) - "names -> DNS server" rules added to
 *                                                   every routing preset; a preset's own
 *                                                   rule with the same name wins. Default none.
 *   - `subscriptionWgDns` (string[] of IPs)       - resolvers for the `DNS =` line of
 *                                                   WireGuard / AmneziaWG configs and
 *                                                   `dns1`/`dns2` of the vpn:// key.
 *                                                   Empty/NULL: no line (default).
 *   - `subscriptionWgDropIpv6` (boolean)          - take `::/0` out of `AllowedIPs`
 *                                                   in every wg config. Default false.
 *   - `wgShowUnusedTunnels` (boolean)             - list never-used wg tunnels among the
 *                                                   devices of the Remnawave-compatible
 *                                                   API. Default false.
 *
 * Future keys land in the same table; flip `isPublic` per key.
 */

const PUBLIC_KEYS = new Set(['brandName']);

/**
 * Read-only values the delivery screen has to show and must not offer to edit.
 *
 * The path prefix is not writable, and not for lack of trying: the
 * subscription route is REGISTERED with it at boot
 * (`app.get(\`${config.SUBSCRIPTION_PATH_PREFIX}/:token\`)`), so a value from
 * the database would not move the route. It would only make the panel
 * advertise an address nothing answers on.
 *
 * `…Source` rather than an `…Editable` boolean, because a boolean reads as
 * "sometimes you may". It is never editable here; what changes is where the
 * value came from, and that is what the screen should say.
 */
const READ_ONLY_KEYS = {
  subscriptionPathPrefix: async () => config.SUBSCRIPTION_PATH_PREFIX,
  subscriptionPathPrefixSource: async () => 'env' as const,
  /**
   * How many live subscriptions the current address is serving.
   *
   * On the screen before the host is changed, not after: every one of these
   * people is holding a link built on the old host, and no redirect we control
   * can save them, because the old name may stop resolving to us at all.
   * A number makes that concrete in a way "this will break existing links"
   * never does.
   */
  subscriptionActiveCount: async () =>
    prisma.user.count({ where: { deletedAt: null, subRevokedAt: null, status: 'active' } }),
} as const;

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings/public', async (_req, reply) => {
    const rows = await prisma.appSetting.findMany({
      where: { isPublic: true },
    });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return reply.send(out);
  });

  app.register(async (admin) => {
    admin.addHook('onRequest', requireAuth);

    admin.get('/api/settings', async (_req, reply) => {
      const rows = await prisma.appSetting.findMany();
      const out: Record<string, unknown> = {};
      /**
       * Every writable key is present, as null when nobody has set it.
       *
       * The read used to dump the rows that exist, so a key nobody had ever
       * saved was simply absent. The screen fell back to its defaults and
       * looked right, but "the operator never set this" and "the operator
       * cleared it" arrived as the same thing, and no screen can tell the
       * difference between a missing key and a missing answer.
       *
       * The list is taken from the schema that accepts writes rather than
       * written out again here: a second list would go stale the first time a
       * setting was added, and go stale invisibly, because a missing key looks
       * exactly like the state this is fixing.
       */
      for (const key of Object.keys(UpdateSettingsSchema.shape)) out[key] = null;
      for (const r of rows) out[r.key] = r.value;
      // Values the screen must show and must not offer to edit. Emitted after
      // the rows so a stale hand-written row can never shadow the truth.
      for (const [key, read] of Object.entries(READ_ONLY_KEYS)) out[key] = await read();
      return reply.send(out);
    });

    admin.put('/api/settings', async (req, reply) => {
      const input = UpdateSettingsSchema.parse(req.body);
      const entries = Object.entries(input).filter(([, v]) => v !== undefined);
      if (input.subscriptionDnsRules) {
        try {
          await checkDnsRules(input.subscriptionDnsRules);
        } catch (err) {
          if (err instanceof RoutingPresetRulesError) {
            return reply.code(400).send({ error: err.code, message: err.message, entries: err.entries });
          }
          throw err;
        }
      }
      // 19.10: the panel-wide DNS rules go to every node, so they must not
      // disagree with the rules of any preset on any node. Checked before
      // anything is written; the nodes are written and pushed after the save.
      let dnsPlan: NodeDnsPlan[] = [];
      if (input.subscriptionDnsRules !== undefined) {
        const row = await prisma.appSetting.findUnique({ where: { key: 'subscriptionDnsRules' }, select: { value: true } });
        if (stableJson(row?.value ?? []) !== stableJson(input.subscriptionDnsRules ?? [])) {
          try {
            dnsPlan = await planDnsTransfer({ presetId: null, rules: input.subscriptionDnsRules ?? [] });
          } catch (err) {
            if (err instanceof RoutingPresetDnsConflictError) {
              return reply.code(409).send({ error: err.code, message: err.message, node: err.node, preset: err.other, domain: err.domain });
            }
            if (err instanceof RoutingPresetDnsLimitError) {
              return reply.code(409).send({ error: err.code, message: err.message, node: err.node, count: err.count });
            }
            throw err;
          }
        }
      }
      // The audit log keeps which settings changed, never their values (the
      // announce template, the support URL and the routing rules are the
      // operator's own text). The screen sends every key on each save, so a
      // key counts only when its value differs from the stored one; a save
      // that changes nothing leaves no row.
      const stored = new Map(
        (await prisma.appSetting.findMany({ where: { key: { in: entries.map(([k]) => k) } }, select: { key: true, value: true } })).map(
          (r) => [r.key, stableJson(r.value)],
        ),
      );
      const changed = entries.filter(([k, v]) => stored.get(k) !== stableJson(v)).map(([k]) => k);
      if (changed.length > 0) {
        audit(req, {
          action: 'settings.update',
          target: { kind: 'settings', id: null, label: 'panel settings' },
          detail: { changed },
        });
      }
      for (const [key, value] of entries) {
        // Prisma's `Json` column accepts any JSON-serialisable value at the
        // SQL layer, but the TS surface insists on `Prisma.InputJsonValue`.
        // Strings ARE valid JSON, so the cast is sound, TS just refuses
        // string→object without the explicit `unknown` step.
        const jsonValue = value as unknown as object;
        await prisma.appSetting.upsert({
          where: { key },
          create: { key, value: jsonValue, isPublic: PUBLIC_KEYS.has(key) },
          // isPublic on BOTH branches: set only on create, a row keeps the
          // visibility it was born with and editing PUBLIC_KEYS changes
          // nothing for a panel that has already written the key.
          update: { value: jsonValue, isPublic: PUBLIC_KEYS.has(key) },
        });
      }
      if (dnsPlan.length > 0) await pushDnsNodes(await prisma.$transaction((tx) => writeDnsPlan(tx, dnsPlan)));
      // B5 - bust the /sub settings cache so admin changes take effect now.
      invalidateSubscriptionSettingsCache();
      return reply.send({ ok: true, updated: entries.map(([k]) => k) });
    });

    /**
     * Does the subscription address answer?
     *
     * ⚠ It answers THE PANEL. The request leaves this container, so it can
     * take an internal route where the outside world is firewalled off, and
     * a green result here is not proof that a subscriber can reach it. The
     * screen says "the address answers the panel" for exactly that reason:
     * the alternative is an operator with a closed 443 spending a day on a
     * green tick.
     */
    admin.post('/api/settings/subscription/probe', async (_req, reply) => {
      const settings = await getSubscriptionSettings();
      const origin = settings.publicHost
        ? `https://${settings.publicHost}`
        : subscriptionOrigin();
      // A token that cannot belong to anybody: the probe wants the transport
      // and the certificate, not somebody's subscription. A 404 from the app
      // is a perfectly good answer, it means the address reached us.
      const url = `${origin}${config.SUBSCRIPTION_PATH_PREFIX}/probe-${randomUUID()}`;
      const started = Date.now();
      const checkedAt = new Date().toISOString();
      try {
        const res = await request(url, {
          method: 'GET',
          headers: { 'user-agent': 'iceslab-panel-probe/1' },
          // A probe that hangs is a probe that tells the operator nothing.
          headersTimeout: 5000,
          bodyTimeout: 5000,
        });
        const body = await readCapped(res.body, 4096);
        const contentType = String(res.headers['content-type'] ?? '');
        // Only the subscription route's own answer for a token nobody owns
        // (A-137, 22.10). It was anything under 500, and with a prefix the
        // frontend's nginx did not route, the SPA's index.html came back with
        // 200 and the probe was green while every subscriber got HTML.
        const ok = subscriptionProbeAnswered(res.statusCode, contentType, body);
        return reply.send({
          ok,
          ...(ok
            ? {}
            : {
                error:
                  `the address answered ${res.statusCode} (${contentType || 'no content type'}), ` +
                  'not the subscription route: the request did not reach the panel backend at this prefix',
              }),
          status: res.statusCode,
          ms: Date.now() - started,
          tlsExpiresAt: await peerCertificateExpiry(url),
          checkedAt,
          url,
        });
      } catch (err) {
        return reply.send({
          ok: false,
          status: 0,
          ms: Date.now() - started,
          tlsExpiresAt: null,
          checkedAt,
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    /**
     * A URL the panel can drop into an iframe to show the real page.
     *
     * The token is random, lives fifteen minutes, and resolves to INVENTED
     * data. Never a live subscriber's: their link in an iframe means their
     * access in the browser history, in the referrer and in every proxy log
     * on the way. `?state=` picks which card to preview, which is the only
     * way to see the expired one without expiring somebody.
     */
    admin.get('/api/settings/subscription/preview-url', async (req, reply) => {
      const q = z
        .object({
          state: z.enum(['active', 'expiring', 'expired', 'limited', 'disabled']).optional(),
          // Same parameter the real page takes, and for a sharper reason here:
          // the operator writes the dead-state texts in TWO languages on this
          // screen and could only ever see one of them, whichever the panel
          // default happened to be. A preview that cannot show the other half
          // of the form is not a preview of it.
          lang: z.enum(['ru', 'en']).optional(),
        })
        .parse(req.query);
      const token = randomUUID();
      await redis.set(
        `sub:preview:${token}`,
        JSON.stringify({ state: q.state ?? 'active', lang: q.lang }),
        'EX',
        900,
      );
      const url = `${config.PUBLIC_URL.replace(/\/$/, '')}/api/settings/subscription/preview/${token}`;
      return reply.send({
        // The language rides in the token AND in the query, so the iframe can
        // switch it without asking for a new token: the in-page RU/EN links on
        // the real page work by query, and the preview must behave the same or
        // it is previewing something else.
        url: q.lang ? `${url}?lang=${q.lang}` : url,
        expiresInSeconds: 900,
      });
    });
  });

  /**
   * The preview itself, public BY THE TOKEN and by nothing else.
   *
   * Outside the authenticated plugin on purpose: an iframe cannot attach the
   * panel's bearer token, so the URL has to carry its own proof. That proof is
   * a random uuid with a fifteen-minute life, and what it unlocks is a page
   * built from invented data, so leaking one costs nothing.
   */
  app.get('/api/settings/subscription/preview/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().uuid() }).parse(req.params);
    const q = z.object({ lang: z.enum(['ru', 'en']).optional() }).parse(req.query);
    const raw = await redis.get(`sub:preview:${token}`);
    if (!raw) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Preview link expired' });
    }
    const { state, lang: tokenLang } = JSON.parse(raw) as {
      state: string;
      lang?: 'ru' | 'en';
    };
    const settings = await getSubscriptionSettings();
    const day = 86_400_000;
    const gib = 1024 ** 3;
    // Invented, and obviously so: the name says preview and the host is the
    // documentation domain. Nothing here reads the database.
    const html = buildSubscriptionPage({
      brandTitle: settings.profileTitle ?? settings.brandName ?? 'Iceslab',
      // Same order the real page uses: the ?lang= in front of the visitor,
      // then what the token was minted with, then the panel default. The page
      // footer's RU/EN links are plain `?lang=` hrefs, so this is what makes
      // them work inside the preview as well.
      lang: q.lang ?? tokenLang ?? settings.defaultLocale ?? 'ru',
      // The operator's OWN wording for the dead states, which is the single
      // thing this preview exists to show them and was not being passed at
      // all: they could switch the state, see our built-in sentence, and never
      // find out what their own looked like on the page.
      deadTexts: settings.deadTexts,
      subUrl: `${subscriptionOrigin()}${config.SUBSCRIPTION_PATH_PREFIX}/preview-token`,
      supportUrl: settings.supportUrl,
      user: {
        username: 'preview',
        status: state === 'active' || state === 'expiring' ? 'active' : state,
        expireAt: new Date(Date.now() + (state === 'expiring' ? 3 : 82) * day).toISOString(),
        trafficLimitBytes: 200 * gib,
        trafficUsedBytes: (state === 'limited' ? 200 : 118) * gib,
      },
      protocols: state === 'active' || state === 'expiring' ? ['xray', 'hysteria', 'shadowsocks'] : [],
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
