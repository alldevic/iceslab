import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { withQuery } from '../subscription.protocols.js';
import { pickServer } from '../endpoint-identity.js';

/**
 * Outline dynamic access key (`?format=outline`): ONE Shadowsocks server.
 *
 * The page hands it out as `ssconf://<host>/sub/<token>?format=outline&node=<id>#<label>`.
 * The Outline app turns `ssconf://` into `https://`, keeps the query, takes the
 * fragment as the server's name (outline-apps
 * client/web/app/outline_server_repository/config.ts:117-127), fetches the
 * address and parses the body as a tunnel config (client/go/outline/parse.go:78-131).
 * The body it reads is an ss:// string, the legacy Shadowsocks object, or the
 * YAML tunnel config. It is NOT a SIP008 list: this format used to answer
 * `{ version, servers: [...] }`, which the app never read, so the Outline card
 * led nowhere.
 *
 * The legacy object it is:
 *   { "server", "server_port", "method", "password" }
 * and nothing else, because an unknown key fails the whole key
 * (configregistry/config_shadowsocks_test.go:141). `prefix` is one the app
 * reads; it is left out until a profile has a field for it.
 *
 * One server per key, so a user with several Shadowsocks nodes gets one link
 * per node, picked with `&node=` as the AmneziaWG files are. Without it, the
 * first. With no Shadowsocks endpoint, an empty body, as wgconf answers.
 *
 * The endpoints come through endpointsForFormat, which drops the 2022-blake3
 * ciphers the Outline SDK does not have (FORMAT_DOORS.outline).
 */
/**
 * The access key the page hands to Outline for one node:
 * `ssconf://<host>/sub/<token>?format=outline&node=<id>#<label>`.
 *
 * `node` is the endpoint's id (endpointId), which no rename and no neighbour
 * moves: Outline saves the key and fetches it on every connect, so a label in
 * it broke the key the day a second profile went on the node (A-107). The
 * label stays in the fragment, the name the app shows.
 *
 * Only from an https subscription address: the app fetches every ssconf:// key
 * over https (config.ts:124-126) and refuses an http:// one outright
 * (config.ts:133), so a panel served over plain http has no key to give.
 */
export function outlineAccessKey(subUrl: string, id: string, label: string): string | undefined {
  if (!subUrl.startsWith('https://')) return undefined;
  const node = encodeURIComponent(id);
  return `ssconf://${withQuery(subUrl.slice('https://'.length), `format=outline&node=${node}`)}#${encodeURIComponent(label)}`;
}

export function buildOutlineJson(endpoints: SubscriptionEndpoint[], node?: string): string {
  const ss = endpoints.filter((e) => e.protocol === 'shadowsocks');
  const e = pickServer(ss, node);
  if (!e || e.protocol !== 'shadowsocks') return '';
  return (
    JSON.stringify({ server: e.host, server_port: e.port, method: e.method, password: e.password }, null, 2) + '\n'
  );
}
