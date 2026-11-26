import { z } from 'zod';
import { DEFAULT_FORMAT_NAMES, ROUTING_PRESET_IDS } from '@iceslab/shared';
import { headerSafeUrl } from '../../lib/util/header-url.js';

/**
 * The body of `PUT /api/settings`. Its own file, away from the routes, so the
 * panel's tests can load it without fastify, prisma and redis (milestone 17.5).
 * The key table and what each key means: the comment above PUBLIC_KEYS in
 * settings.routes.ts.
 */

export const UpdateSettingsSchema = z.object({
  brandName: z.string().min(1).max(64).optional(),
  subscriptionProfileTitle: z.string().min(1).max(128).nullable().optional(),
  subscriptionUpdateIntervalHours: z.number().int().min(1).max(168).optional(),
  // A-168: stored in the form a header carries (punycode host, percent-
  // encoded path and query), so the value the operator sees back is the one
  // clients get. The 255 cap is checked on that form.
  subscriptionSupportUrl: z
    .string()
    .url()
    .transform((v, ctx) => {
      const safe = headerSafeUrl(v);
      if (!safe) {
        ctx.addIssue({ code: 'custom', message: 'not a URL an HTTP header can carry' });
        return z.NEVER;
      }
      return safe;
    })
    .pipe(z.string().max(255))
    .nullable()
    .optional(),
  subscriptionAnnounceTemplate: z.string().max(512).nullable().optional(),
  subscriptionRoutingPreset: z.enum(ROUTING_PRESET_IDS).optional(),
  // Entry pool cap. 0 = hand out every node the subscriber is entitled to,
  // which is the default and what an operator expects after deploying a
  // profile to a node. See SubscriptionSettings.entryPoolSize.
  subscriptionEntryPoolSize: z.number().int().min(0).max(64).optional(),
  // TLS-fragment - split the client's outgoing ClientHello so SNI-based DPI
  // (RU TSPU / RKN) cannot cleanly match the handshake. Xray JSON format only.
  subscriptionTlsFragment: z.boolean().optional(),
  // R3-b - raw custom xray routing rules (array of rule objects), or null to
  // clear. Applied to xray/xkeen subscription output ahead of the preset.
  subscriptionCustomRoutingRules: z
    .array(z.record(z.string(), z.unknown()))
    .max(50)
    .nullable()
    .optional(),
  // R3 - operator-defined custom domain lists (direct/proxy/block), or null to
  // clear. Emitted into xray/xkeen + clash routing rules ahead of the preset.
  subscriptionCustomDomainLists: z
    .object({
      direct: z.array(z.string().min(1).max(253)).max(500).optional(),
      proxy: z.array(z.string().min(1).max(253)).max(500).optional(),
      block: z.array(z.string().min(1).max(253)).max(500).optional(),
    })
    .nullable()
    .optional(),
  // Subscription landing-page default language. The panel's LanguageSwitcher
  // mirrors its UI language here so the human /sub page defaults to the same
  // language the operator runs the panel in. The page also carries an in-page
  // RU/EN selector (?lang=) that overrides per visitor, so this is the default,
  // not a hard lock.
  defaultLocale: z.enum(['ru', 'en']).optional(),
  // What the bare link hands a client that asked for nothing: no ?format=, no
  // user-agent rule, no JSON in Accept. Was hard-coded to `plain`.
  // From the shared list: the frontend's selector reads the same one, so the
  // screen cannot offer a value this refuses. The refusal names the value,
  // because "Invalid enum" about a field the operator did not type by hand is
  // a message with nothing in it.
  subscriptionDefaultFormat: z
    .enum(DEFAULT_FORMAT_NAMES, {
      message: `not a format the bare link can default to. Available: ${DEFAULT_FORMAT_NAMES.join(', ')}`,
    })
    .optional(),
  // One line per server, or one line per server-and-protocol. See
  // SubscriptionSettings.linkShape for the collapsing rule.
  subscriptionLinkShape: z.enum(['per-node', 'per-exit']).optional(),
  // The operator's own wording for a subscription that is not in force. One
  // setting rather than six keys: they are written on one screen, saved by one
  // button and read together. An absent state, or an absent language inside
  // one, means the page's built-in text.
  subscriptionDeadTexts: z
    .object({
      expired: z.object({ ru: z.string().max(400), en: z.string().max(400) }).partial().optional(),
      limited: z.object({ ru: z.string().max(400), en: z.string().max(400) }).partial().optional(),
      disabled: z.object({ ru: z.string().max(400), en: z.string().max(400) }).partial().optional(),
    })
    .nullable()
    .optional(),
  // Host only, no scheme and no path: `nw.example.com`. A scheme is stripped
  // on read rather than rejected here, because an operator pasting a URL is
  // the expected mistake, not a malformed request.
  subscriptionWgDns: z
    .array(z.union([z.ipv4(), z.ipv6()], { message: 'not an IP address' }))
    .max(4)
    .nullable()
    .optional(),
  subscriptionWgDropIpv6: z.boolean().optional(),
  // Whether a wg tunnel nobody has used yet is listed among a buyer's devices
  // in the Remnawave-compatible API. Tunnels are issued up front, one per
  // device the limit allows, so an untouched one is a slot, not a device: off
  // by default. On, the slots show too (the support case "I downloaded the
  // config and nothing appeared"). Stored under this name, not subscription*:
  // it is read by the facade, not by a subscription render.
  wgShowUnusedTunnels: z.boolean().optional(),
  subscriptionPublicHost: z
    .string()
    .max(253)
    .regex(
      /^(https?:\/\/)?[a-z0-9.-]+(:\d{1,5})?$/i,
      'Host only, for example nw.example.com. No path, no trailing slash.',
    )
    .nullable()
    .optional(),
});
