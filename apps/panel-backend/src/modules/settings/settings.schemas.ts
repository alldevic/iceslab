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
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;
