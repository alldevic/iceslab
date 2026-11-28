import { z } from 'zod';
import { canonicalIpv6 } from '@iceslab/shared';
import { collidingHoneypotPrefix } from './lib/auth/honeypot-paths.js';

/** The panel's own routes on the frontend's nginx; see SUBSCRIPTION_PATH_PREFIX. */
export const RESERVED_PATH_PREFIXES: readonly string[] = ['/api', '/admin', '/health', '/assets', '/geo'];

// Exported for the guard test that feeds it a compose-shaped environment: every
// optional setting must survive being handed an EMPTY STRING, because that is
// what `${VAR:-}` in docker-compose delivers when the operator left it blank.
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.url(),
  // Connection-pool ceiling. Bounded like every other number: a negative max
  // makes node-postgres wait forever for a client (it does not even honour
  // connectionTimeoutMillis), so a typo would leave a panel that answers
  // nothing, /health included, and logs nothing. A bad value stops the boot.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  REDIS_URL: z.url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('24h'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Comma-separated list of frontend origins allowed to call the API.
  // Default covers the Vite dev server.
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Public-facing base URL of this panel (e.g. https://panel.example.com).
  // REQUIRED: used to generate bootstrap install commands, subscription
  // links, AND the panelUrl baked into node payloads (slice 38 heartbeat).
  // Letting it be optional silently broke heartbeat self-destruct because
  // agents shipped with `panelUrl=undefined` and never polled, the
  // mechanism that was supposed to revoke a stolen bundle just sat dead.
  PUBLIC_URL: z.url(),
  // Public origin for the CLIENT subscription link (install page + QR). Split
  // from PUBLIC_URL so operators can serve /sub from a separate, CDN/block-
  // resistant domain (e.g. a grey-cloud relay) while the panel/admin and node
  // bootstrap stay on PUBLIC_URL. Falls back to PUBLIC_URL when unset.
  //
  // Empty is read as unset. Compose passes `${VAR:-}` for optional settings, so
  // an operator who has not split the domain still hands the container an EMPTY
  // STRING - which `.url()` rejects, and the panel then refuses to boot at all.
  // That took the panel down on 2026-08-10, and "you left a setting blank" is
  // not a reason to refuse to start.
  SUBSCRIPTION_PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : undefined))
    .pipe(z.url().optional()),

  // Where a PERSON belongs when they open a subscription link in a browser.
  // The link is fetched by two different things: the VPN client, which needs
  // the config, and the buyer, who taps it and gets this panel's install page.
  // When set, a browser gets a 302 to this address instead, and only clients
  // keep talking to /sub. Unset (the default) keeps the page exactly as it is.
  // Precondition for setting it: the portal itself shows the connection for the
  // whole fleet, AmneziaWG included; the page is the only place a buyer gets
  // an AmneziaWG QR until it does. A link that carries a tunnel preselection
  // (`?node=`) still gets the page, and so does a link with `?format=`.
  // The token is NOT appended: it is the subscription credential and the
  // destination is another origin. Blank is read as unset, as for
  // SUBSCRIPTION_PUBLIC_URL above (compose passes `${VAR:-}`).
  CLIENT_PORTAL_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : undefined))
    .pipe(z.url().optional()),

  // Path prefix where the subscription endpoint is mounted. Default
  // `/sub` matches the historical default. Operators with concerns
  // about Iceslab fingerprinting can change it (e.g. `/v` or `/get`)
  // - the backend reads this when registering the subscription route,
  // and `/api/auth/status` surfaces it to the SPA so admin sees the
  // correct full URL when copy-pasting a user's subscription link.
  // Always starts with `/`, no trailing slash.
  //
  // ⚠ One rule in two places (A-137, 22.10): the pattern and the reserved list
  // are the same as apps/panel-frontend/docker-entrypoint.d/15-subscription-
  // prefix.sh, which puts the prefix into an nginx `location`, and they change
  // as a pair. /api, /admin, /health, /assets and /geo (10.4, the geo-file location) are the panel's own routes on
  // that server: a subscription mounted there takes them away or fails nginx.
  // The honeypot trap prefixes (HONEYPOT_PREFIXES) are refused too, in both places.
  SUBSCRIPTION_PATH_PREFIX: z
    .string()
    .regex(/^\/[a-zA-Z0-9_-]+$/, 'Must start with / and use only [a-zA-Z0-9_-]')
    .refine((v) => !RESERVED_PATH_PREFIXES.includes(v), {
      message: `Taken by the panel itself: ${RESERVED_PATH_PREFIXES.join(', ')}`,
    })
    // The honeypot (lib/auth/security-gate.ts) traps these for every path, so a
    // subscription there would 404 and blacklist each subscriber.
    .refine((v) => collidingHoneypotPrefix(v) === null, {
      error: (iss) =>
        `Collides with the honeypot trap prefix ${collidingHoneypotPrefix(String(iss.input))}; ` +
        'every subscriber would be served a fake 404 and blacklisted',
    })
    .default('/sub'),

  // Number of trusted reverse-proxy hops in front of the backend. Zero
  // (default) → request.ip is the immediate socket peer; X-Forwarded-For
  // is ignored. Production behind Caddy + Cloudflare uses 2. Don't bump
  // this above the actual hop count or any client can spoof X-Forwarded-
  // For and bypass per-IP rate limits.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),

  // Per-route rate-limit knobs, tunable per deployment. Defaults are
  // tuned for a small panel; raise on busy multi-thousand-user instances.
  RATE_LIMIT_SUB_PER_MIN: z.coerce.number().int().min(1).default(30),
  // Secondary IP-only ceiling for the subscription endpoint, applied in
  // addition to the per-(ip,token) bucket. The per-token bucket lets an
  // attacker rotate tokens to get a fresh 30/min on each, this catches
  // token rotation by capping total /sub hits per IP. Tune above legit
  // shared-CGNAT polling: e.g. 200 users on one CGNAT NAT at 24h refresh
  // ~= 0.14/min. 120/min is ~1000x that, well clear of legit traffic.
  RATE_LIMIT_SUB_IP_PER_MIN: z.coerce.number().int().min(1).default(120),

  // Public delivery of the geo files to CLIENTS from this panel's own domain
  // (GET /geo/<token>/<file>, geo-sets/geo-public.routes.ts), for networks where
  // GitHub and the CDNs are slow or blocked. Off by default: the address then
  // answers 404 like any unknown path and the panel is the base. Nothing in the
  // subscription points at it yet (that is a later milestone).
  GEO_SELF_HOST: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  // The split presets of the xray-json documents carry the region's domain and
  // IPv4 lists themselves instead of naming geosite:/geoip: categories
  // (milestone 12.5), for ru-split only (cn-split is ~4 MB and stays as the
  // base, with geosite:/geoip:): Happ and INCY on mobile trim their geo files to the tags
  // their routing profile names, and a named category is then missing. The lists
  // come from the panel's verified built-in sets and cost about 300 KB a
  // document; with a set unverified or a category missing the document names the
  // categories as before. Off by default: the document is the base's, byte for
  // byte. Independent of GEO_SELF_HOST.
  SUBSCRIPTION_XRAY_GEO_INLINE: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  // The token in that path. One for the whole panel, and every subscriber's
  // client learns it, so it is a capability against scanners and not a secret:
  // the files it opens are not secret either. Unset (blank counts as unset,
  // compose passes `${VAR:-}`): derived from JWT_SECRET. Revoked by replacing it.
  GEO_ARTIFACT_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .pipe(
      z
        .string()
        .min(16, 'GEO_ARTIFACT_TOKEN must be at least 16 characters')
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/, 'GEO_ARTIFACT_TOKEN: only [A-Za-z0-9_-], it is a path segment')
        .optional(),
    ),
  // The sing-box executable the panel itself runs: the dry-run of a sing-box
  // template and the compiler of `.srs` rule-sets for clients (milestone 10.5).
  // The image sets it. Unset (or blank): the usual install paths are tried, and
  // with none the panel works without: the template check says "not checked" and
  // no `.srs` is served. Read from the environment where it is used
  // (lib/util/singbox-bin.ts), so a path set after start is honoured by tests.
  SINGBOX_BIN: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
  // Downloads of those files per minute per address, 404s included (that is
  // what holds back a guess at the token). A client takes two or three files
  // per refresh.
  RATE_LIMIT_GEO_PER_MIN: z.coerce.number().int().min(1).default(60),

  // Default OFF for alpha: admin-login activity is operational PII and
  // shouldn't auto-ship to a third-party chat. Set =true (and configure
  // TELEGRAM_BOT_TOKEN/CHAT_ID) only if the operator explicitly wants
  // login/lockout alerts. IPs in those alerts are now /24-redacted.
  TELEGRAM_NOTIFY_LOGIN_EVENTS: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  // Remnawave facade switch, off by default. On, the Remnawave-shaped routes
  // are mounted under REMNAWAVE_COMPAT_PREFIX (remnawave-compat module) and the
  // users of a deleted squad are parked in the "No access" squad (squads.service).
  REMNAWAVE_COMPAT_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  // The one path segment the facade is mounted under: /<prefix>/api/*. It is
  // the shop's PANEL_API_URL tail, so it changes together with that. Like
  // SUBSCRIPTION_PATH_PREFIX it may not take a route the panel owns on the same
  // origin or a honeypot trap prefix; that it also differs from the
  // subscription prefix is checked against the whole object (ConfigSchema).
  REMNAWAVE_COMPAT_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Must be one path segment: [a-zA-Z0-9_-], no slashes')
    .refine((v) => !RESERVED_PATH_PREFIXES.includes(`/${v.toLowerCase()}`), {
      message: `Taken by the panel itself: ${RESERVED_PATH_PREFIXES.map((p) => p.slice(1)).join(', ')}`,
    })
    .refine((v) => collidingHoneypotPrefix(`/${v}`) === null, {
      error: (iss) =>
        `Collides with the honeypot trap prefix ${collidingHoneypotPrefix(`/${String(iss.input)}`)}; ` +
        'the shop would be served a fake 404 and blacklisted',
    })
    .default('rw'),
  // The shop's webhook endpoint and the secret it checks X-Remnawave-Signature
  // with. Either empty = no Remnawave-format webhooks (the K2 bus, WEBHOOK_URLS
  // above, is separate and unaffected). Blank reads as unset: compose passes
  // `${KEY:-}`.
  REMNAWAVE_COMPAT_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  REMNAWAVE_COMPAT_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  // Deliveries in flight at once. A single expiry tick can flip thousands of
  // users; the bound protects the shop and this process's sockets (the row is
  // read before the POST, so the database pool is never held for a delivery).
  // 32: the shop handles 50 webhooks at once, sending more only queues there,
  // and far fewer makes the drain long when the shop is down (5000 users at the
  // 5 s timeout: 52 min at 8, under 7 at 32).
  REMNAWAVE_COMPAT_WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(32),
  RATE_LIMIT_BOOTSTRAP_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_HEARTBEAT_PER_MIN: z.coerce.number().int().min(1).default(120),
  // Where the image keeps the core artifacts it hands to nodes (the Dockerfile's
  // `cores` stage writes it), and how often one address may ask for them: a
  // download is tens of MB, so it gets a ceiling of its own, far below the
  // heartbeat's.
  CORES_DIR: z.string().min(1).default('/app/cores'),
  RATE_LIMIT_CORE_PER_MIN: z.coerce.number().int().min(1).default(20),

  // Absolute ceiling on distinct HWID device rows recorded per user, applied
  // even to users with no per-user/squad device limit (the common case, where
  // /sub still upserts one audit row per distinct x-hwid header). The header
  // is client-controlled and unbounded in distinct values, so without a hard
  // cap a single valid token can grow hwid_user_devices one never-pruned row
  // at a time until the disk fills. 1000 is far above any real device count.
  HWID_MAX_DEVICES_PER_USER: z.coerce.number().int().min(1).default(1000),

  // Keyed, rotating entry ordering. Off by default: the subscription's entry
  // order is byte-identical to the unkeyed one until this is set. It pairs
  // with the `subscriptionEntryPoolSize` setting: the cap is what turns the
  // ordering into a per-user SLICE of the fleet, and keying is what stops that
  // slice from being recomputable by anyone who learns the node set. The salt
  // is JWT_SECRET, so rotating that secret reshuffles every subscriber's
  // entries. See RendezvousKeying in subscription/node-selection.ts.
  EXT_DIVERSITY_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  // Rotation window in seconds: a user's slice is stable within a window and
  // moves between windows, so a leaked subscription decays instead of being a
  // permanent view. Default 86400 = daily.
  EXT_DIVERSITY_WINDOW_SEC: z.coerce.number().int().min(60).default(86400),

  // K2: outbound webhook bus. Domain events (user / profile / binding / node
  // lifecycle) are POSTed as signed JSON to these URLs so third parties
  // (billing bots, dashboards, CRMs) can react without polling. This is how an
  // ecosystem grows on top of the panel without us building billing ourselves.
  // Comma-separated URL list; empty = disabled.
  WEBHOOK_URLS: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim()
        ? v
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean)
        : [],
    ),
  // HMAC-SHA256 secret signing each body (X-Iceslab-Signature header over
  // `${timestamp}.${body}`) so receivers can verify authenticity + reject
  // replays via the timestamp. Optional; unsigned if unset (dev only).
  WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // Slice S7: public IP of the panel, baked into the node-install
  // command as `--panel-ip`. Causes the agent's UFW to allow :1337/tcp
  // ONLY from this IP. CRITICAL: must be the panel's *origin* IP, not
  // a Cloudflare edge IP. Optional, without it the install command
  // shows a `--panel-ip <YOUR_IP>` placeholder and admin fills manually.
  // Loose validation: any non-empty token. Operator controls this, no
  // injection vector, UFW will reject malformed IPs at allow-time.
  PANEL_PUBLIC_IP: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // The panel's IPv6 egress address, for a panel that reaches nodes over IPv6
  // (a node on an IPv6 address). Set, the install command names both addresses
  // in `--panel-ip a,b` and the node's ufw opens :1337/tcp from each. Only from
  // this key: there is no probe, a panel in docker often has no IPv6 outward
  // and a probe would answer with its IPv4 or nothing. Blank is read as unset
  // (compose passes `${VAR:-}`); a value that is not an IPv6 literal stops the
  // boot, so a typo does not become a firewall rule that lets nobody in.
  PANEL_PUBLIC_IP6: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const canon = canonicalIpv6(v);
      if (!canon) {
        ctx.addIssue({ code: 'custom', message: `PANEL_PUBLIC_IP6 must be an IPv6 address, got "${v}"` });
        return z.NEVER;
      }
      return canon;
    }),

  // Slice S7: login bruteforce defence. After this many failed logins
  // for the same username (case-insensitive) within the window, lock the
  // account for LOCKOUT_DURATION_MIN minutes regardless of source IP.
  // Per-IP rate limit is separate (faster, lower threshold).
  LOGIN_LOCKOUT_FAILURES: z.coerce.number().int().min(1).default(10),
  LOGIN_LOCKOUT_DURATION_MIN: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCKOUT_WINDOW_MIN: z.coerce.number().int().min(1).default(10),

  // Traffic-anomaly sensor thresholds (modules/stats/stats.anomaly.ts). The
  // defaults are the values the sensor was tuned with on a live fleet; the
  // keys exist so a node with fewer than 5 concurrent users, or a different
  // tolerance for noise, can be tuned without a rebuild.
  // A poll is anomalous when its bytes fall below ANOMALY_DROP_RATIO of the
  // 24h per-poll average AND at least ANOMALY_MIN_USERS_DROP active users are
  // missing against the expected level, ANOMALY_DEBOUNCE polls in a row (30 s each).
  ANOMALY_DROP_RATIO: z.coerce.number().gt(0).max(1).default(0.2),
  ANOMALY_CRITICAL_RATIO: z.coerce.number().gt(0).max(1).default(0.05),
  ANOMALY_MIN_USERS_DROP: z.coerce.number().int().min(1).default(5),
  ANOMALY_DEBOUNCE: z.coerce.number().int().min(1).default(3),
  ANOMALY_MIN_BASELINE_BYTES: z.coerce.number().int().min(0).default(1_000_000),
  ANOMALY_EXPECTED_DECAY: z.coerce.number().gt(0).max(1).default(0.95),

  // Cold-pool replacement (modules/ext_vptech_pool): a node the traffic sensor
  // keeps reporting dark is replaced by a spare from the cold pool. Off by
  // default; off, nothing subscribes and the panel behaves as without it.
  EXT_VPTECH_POOL_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  // The installer of a promoted spare: the playbook of deploy/ansible, run by
  // the panel itself. Playbook empty: the swap only logs what it would have
  // installed and goes on (the operator installs by hand). Inventory empty:
  // ansible's own default. See deploy/ansible/README.md for the docker setup.
  EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK: z.string().default(''),
  EXT_VPTECH_POOL_ANSIBLE_INVENTORY: z.string().default(''),
  EXT_VPTECH_POOL_ANSIBLE_BIN: z
    .string()
    .default('ansible-playbook')
    .transform((s) => s.trim() || 'ansible-playbook'),

  // ACME contact email used by node-installers that need a Let's Encrypt
  // cert (Hysteria 2 / NaiveProxy / Caddy). Optional, install command
  // emits a placeholder when unset, admin fills manually.
  //
  // We coerce empty-string → undefined BEFORE the .email() check because
  // install-iceslab.sh emits `ACME_DEFAULT_EMAIL=` (no value) into the
  // generated .env.production as a "fill me in later" hint, and Zod's
  // bare `.email().optional()` rejects "" as an invalid email rather than
  // treating it as absent. Same pattern as PANEL_PUBLIC_IP / TELEGRAM_*.
  ACME_DEFAULT_EMAIL: z
    .preprocess((v) => (v === '' ? undefined : v), z.email().optional()),

  // Tier-1 security: Telegram alert webhook (cycle #5 SECURITY.md).
  // When BOT_TOKEN + CHAT_ID are both set, the panel pushes notifications
  // for high-signal security events:
  //   - admin login success / lockout / failed lockout
  //   - node self-destruct trigger
  //   - node bootstrap token issued
  // Optional, when either is unset, calls to `notifyTelegram` are no-ops.
  // Get a bot token from @BotFather; chat_id from @userinfobot.
  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  TELEGRAM_CHAT_ID: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // Tier-1 security: admin geo-block. CSV list of ISO 3166-1 alpha-2
  // country codes allowed on `/api/*` routes EXCEPT the public-by-design
  // ones (subscription, heartbeat, bootstrap). Empty → disabled (any
  // country allowed). The country is read from `CF-IPCountry` (Cloudflare
  // edge header) and falls back to `X-Country-Code` if a non-Cloudflare
  // front-edge wants to opt in. When the header is missing entirely on a
  // gated request we DENY (fail-closed). Cloudflare orange-cloud is a
  // hard prerequisite for this control.
  ADMIN_ALLOWED_COUNTRIES: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter((s) => /^[A-Z]{2}$/.test(s))
        : [],
    ),

  // Tier-1 security: honey-route blacklist TTL (seconds). When an IP
  // hits a known scanner path (/wp-admin, /.env, ...), we surface a
  // plausible fake response AND add the IP to `sec:blacklist:<ip>` in
  // Redis for this duration. Subsequent requests from that IP get a
  // fast 403 before any business logic runs. 3600s = 1h is a reasonable
  // default, long enough to wear a scanner down, short enough that a
  // legit user on a shared-NAT egress isn't permanently shut out.
  HONEYPOT_BLACKLIST_TTL_SEC: z.coerce.number().int().min(60).default(3600),

  // Tier-1 security: honey subscription tokens. CSV of tokens admin
  // deliberately places in suspicious channels (pastebins, screenshots,
  // semi-public Telegram chats) as a leak tripwire. ANY hit on
  // `/sub/<honey>` fires a Telegram alert with source IP + UA + path,
  // returns a plausible empty subscription, and blacklists the source
  // IP for HONEYPOT_BLACKLIST_TTL_SEC. The token never matches a real
  // user. Empty list → feature disabled.
  HONEY_USER_TOKENS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length >= 8 && s.length <= 128)
        : [],
    ),
}).superRefine((c, ctx) => {
  // Two mounts on one first segment: the facade's /<prefix>/api/* would shadow
  // or be shadowed by the subscription route. The case is folded, as in a URL
  // the two are one path to every client that normalises it.
  if (c.REMNAWAVE_COMPAT_PREFIX.toLowerCase() === c.SUBSCRIPTION_PATH_PREFIX.slice(1).toLowerCase()) {
    ctx.addIssue({
      code: 'custom',
      path: ['REMNAWAVE_COMPAT_PREFIX'],
      message: `Same path as SUBSCRIPTION_PATH_PREFIX (${c.SUBSCRIPTION_PATH_PREFIX}); pick another segment`,
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

// The JWT_SECRET shipped in .env.test (committed so CI / contributors can
// run vitest without provisioning their own). It MUST never reach a
// non-test environment, if it did, every JWT signed by the running panel
// would be forgeable by anyone who's ever cloned the repo. Guard at boot.
const TEST_JWT_SECRET = 'test_secret_at_least_32_characters_long_for_zod_validation';

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(parsed.error.format());
    process.exit(1);
  }
  if (parsed.data.NODE_ENV !== 'test' && parsed.data.JWT_SECRET === TEST_JWT_SECRET) {
    console.error(
      '❌ JWT_SECRET matches the public .env.test fixture in NODE_ENV=' +
        parsed.data.NODE_ENV +
        '. Refuse to boot: replace JWT_SECRET in your .env(.production) with a fresh random secret.',
    );
    process.exit(1);
  }
  return parsed.data;
}

export const config: Config = Object.freeze(loadConfig());

// The origin every CLIENT subscription link is built on: SUBSCRIPTION_PUBLIC_URL
// when the operator split /sub onto its own domain, the panel's own otherwise.
// Both producers go through here (the install page and the copy-paste link the
// panel shows an admin), so the two can never disagree about which domain a
// token lives on - an admin copying the panel domain after a split would be
// handing out the address the split existed to retire. Trailing slash is
// stripped once, here, instead of at each concatenation site.
export function subscriptionOrigin(
  cfg: Pick<Config, 'PUBLIC_URL' | 'SUBSCRIPTION_PUBLIC_URL'> = config,
): string {
  return (cfg.SUBSCRIPTION_PUBLIC_URL ?? cfg.PUBLIC_URL).replace(/\/$/, '');
}
