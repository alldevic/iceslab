import type { TemplateType } from '@iceslab/shared';

/**
 * A-236: the built-in "Default" template of each type, held HERE, in the code
 * (decision of ARCH, 23.10, docs/design/decisions.md "Шаг 2, два решения").
 *
 * A row named Default exists in subscription_templates only while the
 * operator has edited it; "restore default" deletes the row and this body is
 * in force again. So a change to a body below reaches every panel whose
 * operator has not edited theirs, which a copy put in the table on first read
 * would not. (The header of migration 20261023163439 still says "put in the
 * table on the first read": that was the plan before the decision, and an
 * applied migration is not edited.)
 *
 * Each Default has a fixed id, one per type, so the screen can PUT, restore
 * and refer to it whether or not a row exists.
 *
 * The bodies are frames: the panel puts the nodes in (proxies, the groups'
 * members, the outbounds, a selector's members), and `iceslab: { routing:
 * preset }` asks for the parts the routing preset in force decides today (the
 * DNS, the geo databases and the rules). They are the shape of what the
 * builders write today; step 3 of the plan holds them to it byte for byte
 * (golden), and may still adjust a body here, which is the point of keeping
 * them in the code.
 */

export const DEFAULT_TEMPLATE_NAME = 'Default';

/** When the bodies below last changed: what a code Default answers as its
 *  updatedAt, since it has no row. */
export const DEFAULT_TEMPLATES_REVISION = '2026-10-23T00:00:00.000Z';

export const DEFAULT_TEMPLATE_IDS: Record<TemplateType, string> = {
  mihomo: '5a3c0236-0000-4000-8000-000000000001',
  stash: '5a3c0236-0000-4000-8000-000000000002',
  clash: '5a3c0236-0000-4000-8000-000000000003',
  singbox: '5a3c0236-0000-4000-8000-000000000004',
  'xray-json-array': '5a3c0236-0000-4000-8000-000000000005',
  'xray-json': '5a3c0236-0000-4000-8000-000000000006',
};

const CLASH_FAMILY = `# The panel fills \`proxies\` and every group's \`proxies\` with the nodes.
# \`iceslab: { routing: preset }\` puts in the DNS, the geo databases and the
# rules of the routing preset in force, ahead of the rules below.
iceslab:
  routing: preset
proxies:
proxy-groups:
  - name: Auto
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
rules:
  - MATCH,Auto
`;

// sing-box 1.12+: rule actions, no legacy fields (no `sniff` on the inbound,
// no `external_ui_download_detour`). The selector lists `direct` after the
// nodes the panel puts in front of it.
const SINGBOX = `{
  "iceslab": { "routing": "preset" },
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.18.0.1/30", "fdfe:dcba:9876::1/126"],
      "auto_route": true,
      "strict_route": false,
      "stack": "mixed"
    }
  ],
  "outbounds": [
    { "type": "selector", "tag": "Auto", "outbounds": ["direct"] },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "final": "Auto", "auto_detect_interface": true }
}
`;

const SOCKS_IN = `{
      "tag": "socks-in",
      "port": 10808,
      "listen": "127.0.0.1",
      "protocol": "socks",
      "settings": { "auth": "noauth", "udp": true }
    }`;

// xray-json-array: the body is ONE config, the frame of each element. The
// panel writes one copy per node, the node's outbound first and its remarks on
// top; `iceslab` sits on that one object and is removed from every copy.
const XRAY_JSON_ARRAY = `{
  "iceslab": { "routing": "preset" },
  "log": { "loglevel": "warning" },
  "inbounds": [
    ${SOCKS_IN}
  ],
  "outbounds": [
    { "tag": "direct", "protocol": "freedom" },
    { "tag": "block", "protocol": "blackhole" }
  ],
  "routing": {
    "rules": [
      { "type": "field", "protocol": ["bittorrent"], "outboundTag": "direct" }
    ]
  }
}
`;

// xray-json: our own contract, every node in ONE config, a balancer over them
// when asked; the panel puts the proxy outbounds first and the catch-all last.
const XRAY_JSON = `{
  "iceslab": { "routing": "preset" },
  "log": { "loglevel": "warning" },
  "inbounds": [
    ${SOCKS_IN}
  ],
  "outbounds": [
    { "tag": "direct", "protocol": "freedom" },
    { "tag": "block", "protocol": "blackhole" }
  ],
  "routing": { "rules": [] }
}
`;

export const DEFAULT_TEMPLATE_BODIES: Record<TemplateType, string> = {
  mihomo: CLASH_FAMILY,
  stash: CLASH_FAMILY,
  clash: CLASH_FAMILY,
  singbox: SINGBOX,
  'xray-json-array': XRAY_JSON_ARRAY,
  'xray-json': XRAY_JSON,
};

/** The type whose Default has this id, or null. */
export function defaultTypeOf(id: string): TemplateType | null {
  for (const [type, defaultId] of Object.entries(DEFAULT_TEMPLATE_IDS)) {
    if (defaultId === id) return type as TemplateType;
  }
  return null;
}

/** Default, in any case and with blanks at the ends: the reserved name. */
export function isReservedName(name: string): boolean {
  return name.trim().toLowerCase() === DEFAULT_TEMPLATE_NAME.toLowerCase();
}
