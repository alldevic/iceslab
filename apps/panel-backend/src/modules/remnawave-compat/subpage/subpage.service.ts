// Resolve one subscription into the install document the shop renders for it.
//
// The shop calls `GET /subscriptions/subpage-config/{shortUuid}` with the
// subscription's short uuid, which in this facade IS the subscription token
// (`remnawave.mappers.ts` exposes `subscriptionToken` as `shortUuid`). So the
// same call that asks "what should this person's install screen say" also tells
// us exactly whose screen it is.

import { config, subscriptionOrigin } from '../../../config.js';
import { getLogger } from '../../../lib/logger.js';
import * as service from '../../subscription/subscription.service.js';
import { collectWgNodes } from '../../subscription/formats/wg-nodes.js';
import { getSubscriptionSettings } from '../../settings/settings.service.js';
import { buildSubpageConfig, type SubpageConfig } from './subpage-config.js';

const logger = getLogger();

/**
 * The v1 document for this subscription, or `null` when we have nothing
 * specific to say and the shop should fall back to its own.
 *
 * Every "no" is a null, never a throw: this route is a display path, and a
 * revoked or expired subscription must not turn the shop's install screen into
 * an error. `generateSubscription` signals both of those by exception.
 */
export async function subpageConfigForToken(token: string): Promise<SubpageConfig | null> {
  let result: Awaited<ReturnType<typeof service.generateSubscription>>;
  try {
    result = await service.generateSubscription(token);
  } catch (err) {
    if (
      err instanceof service.SubscriptionNotFoundError ||
      err instanceof service.SubscriptionForbiddenError
    ) {
      return null;
    }
    throw err;
  }

  // Which protocols this person holds: every endpoint counts, because the apps
  // that take the subscription URL will fetch whichever format they prefer.
  const protocols = [...new Set(result.endpoints.map((e) => e.protocol))];
  if (protocols.length === 0) return null;

  // The tunnel downloads are a different question. Those buttons link to
  // `?format=wgconf`, so a host the admin switched off for that format serves
  // nothing behind them and must not be offered — the same host-level format
  // gate the subscription routes apply before handing work to a formatter.
  const wgEndpoints = result.endpoints.filter(
    (e) => !(e.disableForFormats ?? []).includes('wgconf'),
  );

  const settings = await getSubscriptionSettings();
  const subUrl = `${subscriptionOrigin()}${config.SUBSCRIPTION_PATH_PREFIX}/${token}`;
  const title = settings.profileTitle ?? settings.brandName ?? 'Iceslab';

  const doc = buildSubpageConfig({
    subUrl,
    protocols,
    awgNodes: collectWgNodes(wgEndpoints, 'amneziawg').map((n) => ({
      nodeName: n.nodeName,
      vpnKey: n.vpnKey ?? undefined,
    })),
    wgNodes: collectWgNodes(wgEndpoints, 'wireguard').map((n) => ({ nodeName: n.nodeName })),
    branding: {
      title,
      // brandingSettings is validated by the shop and rendered by nothing —
      // grepped across its frontend and backend, only its preview mock touches
      // it. These two are here to pass `_assert_http_url`, which demands an
      // http(s) URL with a host. If a later shop release starts SHOWING them,
      // this is the line that has to learn a real logo and a real support link.
      logoUrl: subscriptionOrigin(),
      supportUrl: settings.supportUrl ?? subscriptionOrigin(),
    },
  });

  if (!doc) {
    // Reached when the buyer holds protocols the catalogue has no client for on
    // any platform — mtproto today. Worth a line: it means somebody is selling
    // access this panel cannot tell anyone how to use.
    logger.warn(
      { protocols },
      'subpage-config: no client in the catalogue for this subscription, shop falls back to its own guide',
    );
  }
  return doc;
}
