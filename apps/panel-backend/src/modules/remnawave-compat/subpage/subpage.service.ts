// Resolve one subscription into the install document the shop renders for it.
//
// The shop calls `GET /subscriptions/subpage-config/{shortUuid}` with the
// subscription's short uuid, which in this facade IS the subscription token
// (`remnawave.mappers.ts` exposes `subscriptionToken` as `shortUuid`). So the
// same call that asks "what should this person's install screen say" also tells
// us exactly whose screen it is.

import { getLogger } from '../../../lib/infra/logger.js';
import * as service from '../../subscription/subscription.service.js';
import { subscriptionUrl } from '../../subscription/subscription.link.js';
import { subscriptionOrigin } from '../../../config.js';
import { getSubscriptionSettings } from '../../settings/settings.service.js';
import { pageHandouts, wgClientOpts } from '../../subscription/subscription.page-handouts.js';
import { usableFormats } from '../../subscription/subscription.usable-formats.js';
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
    // No request context: this is the shop asking what to DRAW, not a client
    // fetching its config, and a call that does not ask for it
    // (`RequestContext.recordFetch`, A-167) writes nothing to
    // subscription_request_history. Recorded, it would land there with no IP and
    // no User-Agent and inflate the insights dashboard's distinct-user count,
    // hour histogram and client-family split with traffic no client generated.
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

  const settings = await getSubscriptionSettings();
  const subUrl = await subscriptionUrl(token);
  const title = settings.profileTitle ?? settings.brandName ?? 'Iceslab';

  // The tunnel files, keys and proxy links are the page's own handouts, so the
  // gate on `wgconf` / `amneziavpn` / `outline` per host is the page's too: a
  // host switched off for a file leaves no button that links to it. Not
  // format-gated for MTProto: the t.me link is built from the endpoint itself
  // and fetches nothing back from us.
  const { awgNodes, wgNodes, mtprotoNodes, outlineNodes } = pageHandouts({
    endpoints: result.endpoints,
    mtprotoFrom: result.endpoints,
    subUrl,
    wgOpts: await wgClientOpts(),
  });

  const doc = buildSubpageConfig({
    subUrl,
    protocols,
    usableFormats: usableFormats(result.endpoints),
    awgNodes,
    wgNodes,
    mtprotoNodes,
    outlineNodes,
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
    // any platform. Worth a line: it means somebody is selling access this
    // panel cannot tell anyone how to use.
    logger.warn(
      { protocols },
      'subpage-config: no client in the catalogue for this subscription, shop falls back to its own guide',
    );
  }
  return doc;
}
