// The install documents of the compatibility API: one for a subscription,
// and the shared one the shop falls back to.

import { subscriptionOrigin } from '../../../config.js';
import { prisma } from '../../../prisma.js';
import { getLogger } from '../../../lib/infra/logger.js';
import * as service from '../../subscription/subscription.service.js';
import { subscriptionUrl } from '../../subscription/subscription.link.js';
import { withoutDescription } from '../../subscription/subscription.formats.js';
import { pageHandouts } from '../../subscription/subscription.page-handouts.js';
import { protocolsOf } from '../../subscription/subscription.protocols.js';
import { getSubscriptionSettings } from '../../settings/settings.service.js';
import { buildSubpageConfig, SUBSCRIPTION_LINK_PLACEHOLDER, type SubpageConfig } from './subpage-config.js';

/** The uuid of the shared document: the one the shop takes for the panel's
 *  default when the list names it. */
export const SHARED_SUBPAGE_CONFIG_UUID = '00000000-0000-0000-0000-000000000000';

async function branding(): Promise<SubpageConfig['brandingSettings']> {
  const settings = await getSubscriptionSettings();
  return {
    title: settings.profileTitle ?? settings.brandName ?? 'Iceslab',
    // Validated by the shop (an http(s) URL with a host) and drawn by nothing.
    logoUrl: subscriptionOrigin(),
    supportUrl: settings.supportUrl ?? subscriptionOrigin(),
  };
}

/**
 * The document for one subscription (the short uuid of the compatibility API is
 * the subscription token), or null when there is nothing specific to say and
 * the shop should draw its own: an unknown, revoked, disabled, expired or
 * limited subscription, or one with nothing to connect to.
 *
 * What it holds is what the subscription page shows this person in a browser:
 * the same public endpoints (no hidden host, no server description), the same
 * format gate (`plain`, the format a browser resolves to), the same apps and
 * handouts. Not recorded as a fetch: the shop asking what to draw is not a
 * client taking its config.
 */
export async function subpageConfigForToken(token: string): Promise<SubpageConfig | null> {
  let generated: Awaited<ReturnType<typeof service.generateSubscription>>;
  try {
    generated = await service.generateSubscription(token);
  } catch (err) {
    if (err instanceof service.SubscriptionNotFoundError || err instanceof service.SubscriptionForbiddenError) return null;
    throw err;
  }
  const endpoints = generated.endpoints.filter((e) => !e.hidden).map(withoutDescription);
  if (endpoints.length === 0) return null;
  const subUrl = await subscriptionUrl(token);
  const doc = buildSubpageConfig({ subUrl, handouts: pageHandouts(endpoints, 'plain', subUrl), branding: await branding() });
  if (!doc) {
    getLogger().warn(
      { protocols: protocolsOf(endpoints) },
      '[compat] subpage-config: no app for this subscription on any platform the shop has; it draws its own guide',
    );
  }
  return doc;
}

/**
 * The shared document: the apps for every protocol this panel hands out now
 * (an enabled profile bound to a node in service), with the shop's own
 * placeholder for the link. No per-node handouts: those belong to a person.
 */
export async function sharedSubpageConfig(): Promise<SubpageConfig | null> {
  const profiles = await prisma.profile.findMany({
    where: {
      enabled: true,
      bindings: { some: { enabled: true, node: { deletedAt: null, status: { not: 'disabled' } } } },
    },
    select: { protocol: true },
  });
  const protocols = protocolsOf(profiles);
  if (protocols.length === 0) return null;
  return buildSubpageConfig({
    subUrl: SUBSCRIPTION_LINK_PLACEHOLDER,
    handouts: { protocols, awgNodes: [], mtprotoNodes: [], telegramProxies: [], outlineNodes: [] },
    branding: await branding(),
  });
}
