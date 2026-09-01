import { buildAmneziaVpnLink } from '../../../core-adapters/amneziawg/index.js';
import type {
  SubscriptionEndpoint,
  AmneziawgSubscriptionEndpoint,
} from '../subscription.formats.js';

/**
 * AmneziaVPN-app "vpn://" connection key for an AmneziaWG endpoint.
 *
 * Distinct from buildWgQuickConf (raw .conf, for the AmneziaWG app / wg-quick):
 * the flagship AmneziaVPN app only imports its own vpn:// keys, so this is what
 * its QR scanner and "paste key" accept. Single tunnel per key (like wgconf),
 * so `nodeName` selects which AmneziaWG node; absent = first.
 *
 * `dns` lands in the key's `dns1`/`dns2` fields. It has to be threaded here
 * too, not only into the .conf: on connect the AmneziaVPN daemon REBUILDS the
 * [Interface] from the structured fields and ignores the embedded .conf text,
 * so a DNS line present in the file alone would never reach this client.
 *
 * Returns '' when no matching AmneziaWG endpoint exists.
 */
export function buildAwgVpnLink(
  endpoints: SubscriptionEndpoint[],
  nodeName?: string,
  dns?: string[],
  device?: string,
): string {
  let awgEndpoints = endpoints.filter(
    (e): e is AmneziawgSubscriptionEndpoint => e.protocol === 'amneziawg',
  );
  // A key is one tunnel, so it names one device. Accepts the id or the 1-based
  // position, same as wgconf - the buyer's links carry the position. Absent =
  // the first, which is the pre-devices behaviour and what a single-device
  // buyer gets anyway.
  if (device) {
    const byIndex = Number(device);
    awgEndpoints = awgEndpoints.filter(
      (e) => e.deviceId === device || (Number.isInteger(byIndex) && e.deviceIndex === byIndex),
    );
  }
  const awg = nodeName
    ? awgEndpoints.find((e) => e.nodeName === nodeName)
    : awgEndpoints[0];
  if (!awg) return '';

  return buildAmneziaVpnLink({
    privateKey: awg.privateKey,
    allowedIp: awg.allowedIp,
    serverPublicKey: awg.serverPublicKey,
    host: awg.host,
    port: awg.port,
    jc: awg.jc,
    jmin: awg.jmin,
    jmax: awg.jmax,
    s1: awg.s1,
    s2: awg.s2,
    s3: awg.s3,
    s4: awg.s4,
    h1: awg.h1,
    h2: awg.h2,
    h3: awg.h3,
    h4: awg.h4,
    i1: awg.i1,
    i2: awg.i2,
    i3: awg.i3,
    i4: awg.i4,
    i5: awg.i5,
    dns,
    description: `AmneziaWG ${awg.nodeName}${awg.deviceIndex > 1 ? ` #${awg.deviceIndex}` : ''}`,
  });
}
