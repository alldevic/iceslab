import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROUTING_PRESET_IDS } from '@iceslab/shared';
import { requireAuth } from '../auth/auth.hook.js';
import { prisma } from '../../prisma.js';
import { invalidateSubscriptionSettingsCache } from './settings.service.js';
import { UpdateSettingsSchema } from './settings.schemas.js';

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
 *   - `subscriptionWgDns` (string[]): resolvers for the `DNS =` line of every
 *                                                   wg-quick config. Empty omits
 *                                                   the line; for a full tunnel
 *                                                   that leaves the client on a
 *                                                   resolver it can no longer
 *                                                   reach.
 *
 * Future keys land in the same table; flip `isPublic` per key.
 */

const PUBLIC_KEYS = new Set(['brandName']);


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
      for (const r of rows) out[r.key] = r.value;
      return reply.send(out);
    });

    admin.put('/api/settings', async (req, reply) => {
      const input = UpdateSettingsSchema.parse(req.body);
      const entries = Object.entries(input).filter(([, v]) => v !== undefined);
      for (const [key, value] of entries) {
        // Prisma's `Json` column accepts any JSON-serialisable value at the
        // SQL layer, but the TS surface insists on `Prisma.InputJsonValue`.
        // Strings ARE valid JSON, so the cast is sound, TS just refuses
        // string→object without the explicit `unknown` step.
        const jsonValue = value as unknown as object;
        await prisma.appSetting.upsert({
          where: { key },
          create: { key, value: jsonValue, isPublic: PUBLIC_KEYS.has(key) },
          // isPublic on BOTH branches. It used to be set only on create, which
          // made the comment above PUBLIC_KEYS true exactly once per install:
          // the visibility a row was born with was the visibility it kept, and
          // editing the set changed nothing for any panel that had already
          // written the key. Both directions cost something — a key taken out
          // of the set because it leaked kept leaking after the fix shipped,
          // and a key put in never became readable by the unauthenticated SPA
          // that needed it.
          update: { value: jsonValue, isPublic: PUBLIC_KEYS.has(key) },
        });
      }
      // B5 - bust the /sub settings cache so admin changes take effect now.
      invalidateSubscriptionSettingsCache();
      return reply.send({ ok: true, updated: entries.map(([k]) => k) });
    });
  });
}
