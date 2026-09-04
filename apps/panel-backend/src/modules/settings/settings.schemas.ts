import { z } from 'zod';
import { ROUTING_PRESET_IDS } from '@iceslab/shared';

// Exported so the panel-frontend round-trip door can hand this the payload its
// settings pages build, instead of restating the rules in a fixture that would
// go stale in the one direction that hides the bug.
export const UpdateSettingsSchema = z.object({
  brandName: z.string().min(1).max(64).optional(),
  subscriptionProfileTitle: z.string().min(1).max(128).nullable().optional(),
  subscriptionUpdateIntervalHours: z.number().int().min(1).max(168).optional(),
  subscriptionSupportUrl: z.string().url().max(255).nullable().optional(),
  subscriptionAnnounceTemplate: z.string().max(512).nullable().optional(),
  subscriptionRoutingPreset: z.enum(ROUTING_PRESET_IDS).optional(),
  // Entry pool cap. 0 = hand out every node the subscriber is entitled to,
  // which is the default and what an operator expects after deploying a
  // profile to a node. See SubscriptionSettings.entryPoolSize.
  subscriptionEntryPoolSize: z.number().int().min(0).max(64).optional(),
  // TLS-fragment - split the client's outgoing ClientHello so SNI-based DPI
  // (RU TSPU / RKN) cannot cleanly match the handshake. Xray JSON format only.
  subscriptionTlsFragment: z.boolean().optional(),
  subscriptionLocalProxyAuth: z.boolean().optional(),
  // Resolvers written into the `DNS =` line of every wg-quick config we hand
  // out (both flavours). Empty / null omits the line, which is the previous
  // behaviour and NOT a safe default for a full tunnel: with
  // `AllowedIPs = 0.0.0.0/0` the client keeps the network's own resolver, and
  // when that resolver is a LAN address (192.168.1.1 on any home router) the
  // query is routed INTO the tunnel and dies there. Handshake up, no names.
  // Plain IPs only: wg-quick feeds this to resolvconf, which takes addresses.
  subscriptionWgDns: z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .max(4)
    .nullable()
    .optional(),
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
  // Whether a wg tunnel that has never handshaked is listed as a device.
  //
  // Tunnels are PRE-CUT: the buyer gets one per device their limit allows, all
  // minted up front, because the install screen is rendered from what we hand
  // the shop and a fixed set of "Device 1..N" links needs no button there. So a
  // buyer with a limit of ten has ten tunnels the moment they exist, and on the
  // live fleet one of them had exactly that - ten tunnels, not one handshake.
  // Listing those as devices would tell them they own ten things they have
  // never used.
  //
  // Off by default for that reason: a device is something in use. On, the slots
  // show too, which is what an operator wants when a buyer says "I downloaded
  // the config and nothing appeared".
  wgShowUnusedTunnels: z.boolean().optional(),
  // Subscription landing-page default language. The panel's LanguageSwitcher
  // mirrors its UI language here so the human /sub page defaults to the same
  // language the operator runs the panel in. The page also carries an in-page
  // RU/EN selector (?lang=) that overrides per visitor, so this is the default,
  // not a hard lock.
  defaultLocale: z.enum(['ru', 'en']).optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
