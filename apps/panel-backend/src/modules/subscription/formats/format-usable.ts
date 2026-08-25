// Which client formats give THIS buyer anything at all.
//
// A format that cannot express an endpoint's transport skips it — the project
// took that trade deliberately ("an empty section in a client is a bad outcome;
// a server entry that fails every connect and says nothing is worse"). The
// consequence is a whole fleet's worth of clients handing back nothing: on an
// XHTTP-only fleet, sing-box, Loon, Surge and Quantumult X all render an empty
// config. Skipping is right; going on to RECOMMEND those clients is not.
//
// So this asks the question by rendering, not by consulting a table of which
// format understands which transport. A table would be a second copy of what
// the builders do, and the copy is what goes stale — the characterisation test
// next door exists precisely because that knowledge is hard to hold still.
// Running the builder over the buyer's own endpoints cannot drift from the
// builder.
//
// It leans on ONE invariant, and that invariant is what `transport-matrix.test.ts`
// pins: no cell of that table is `degraded` or `dropped` — every format either
// carries a transport or omits the endpoint entirely. That is what makes "an
// entry came out" mean "the client can use it". If a format ever starts
// emitting an entry it cannot carry, the matrix test fails first, and this file
// becomes wrong at the same moment. They move together on purpose.

import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import { buildXrayJson } from './xrayjson.js';

/** The core a client speaks, and so the format it fetches. */
export type ClientFormat = 'plain' | 'singbox' | 'clash' | 'xrayjson';

/** Outbound types sing-box emits as scaffolding rather than as a server. */
const SINGBOX_SCAFFOLDING = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);

function clashHasProxy(endpoints: SubscriptionEndpoint[]): boolean {
  // The builder emits `proxies:\n  []` when it has nothing; a real entry is a
  // `  - name:` line under it.
  return /^\s+- name:/m.test(buildClashYaml(endpoints));
}

function singboxHasServer(endpoints: SubscriptionEndpoint[]): boolean {
  try {
    const doc = JSON.parse(buildSingboxJson(endpoints)) as {
      outbounds?: { type?: string }[];
    };
    return (doc.outbounds ?? []).some((o) => !SINGBOX_SCAFFOLDING.has(o.type ?? ''));
  } catch {
    return false;
  }
}

function xrayHasServer(endpoints: SubscriptionEndpoint[]): boolean {
  try {
    const doc = JSON.parse(buildXrayJson(endpoints)) as {
      outbounds?: { protocol?: string }[];
    };
    return (doc.outbounds ?? []).some(
      (o) => o.protocol !== 'freedom' && o.protocol !== 'blackhole',
    );
  } catch {
    return false;
  }
}

/**
 * The formats that produce at least one server entry for these endpoints.
 *
 * `plain` is the base64 URI list, so it carries exactly the endpoints that have
 * a share-link — which is how a WireGuard-only buyer ends up with nothing in it.
 */
export function usableFormats(endpoints: SubscriptionEndpoint[]): Set<ClientFormat> {
  const usable = new Set<ClientFormat>();
  if (endpoints.length === 0) return usable;
  if (endpoints.some((e) => (e.uri ?? '').length > 0)) usable.add('plain');
  if (clashHasProxy(endpoints)) usable.add('clash');
  if (singboxHasServer(endpoints)) usable.add('singbox');
  if (xrayHasServer(endpoints)) usable.add('xrayjson');
  return usable;
}
