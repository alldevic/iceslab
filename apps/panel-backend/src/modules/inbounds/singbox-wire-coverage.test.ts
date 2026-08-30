import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fieldsUnsupportedByEngine } from '../profiles/profiles.schemas.js';

/**
 * The panel may push any key of `XrayInboundCfg` to a node. When the profile's
 * engine is sing-box, that config is decoded by `xrayFamilyWire` in the
 * node-agent — a plain `json.Unmarshal` into a struct, so a key the struct does
 * not declare does not fail, it VANISHES. The push succeeds, the node comes up
 * healthy, and the feature the panel shows as enabled is not there.
 *
 * That was not hypothetical. Measured on a lab node 2026-08-30, three keys took
 * exactly that path: `realityXver`, both `realityLimitFallback*` throttles, and
 * `warp` (a node showing WARP egress in the panel whose rendered sing-box config
 * held one outbound, `direct`). The guard list knew about three OTHER keys and
 * had never been checked for completeness.
 *
 * So the completeness is checked here, from the two sources themselves rather
 * than from a restatement of either: the panel's wire contract on one side, the
 * agent's struct tags on the other. Every key the agent does not read must be
 * named below WITH the reason it is safe to drop — and "safe" means one of two
 * things only: the key is a client-side half the node never needed, or it is
 * reachable only under a value `toInboundConfig` already refuses.
 *
 * A new key on either side breaks this test, which is the point: adding one to
 * XrayInboundCfg without deciding what sing-box does with it is the exact
 * mistake that produced the three above.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Strip // and block comments. A mirror that reads source MUST do this: the
 *  prose around a field mentions other fields by name. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Member names of a TypeScript interface, in declaration order. */
function interfaceKeys(src: string, name: string): string[] {
  const start = src.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = stripComments(src.slice(open + 1, end));
  return [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]);
}

/** `json:"name"` tags of a Go struct, in declaration order. */
function goStructJsonTags(src: string, name: string): string[] {
  const start = src.indexOf(`type ${name} struct {`);
  if (start < 0) throw new Error(`struct ${name} not found`);
  const end = src.indexOf('\n}', start);
  const body = stripComments(src.slice(start, end));
  return [...body.matchAll(/`json:"([^",]+)/g)].map((m) => m[1]);
}

const transportSrc = readFileSync(`${repoRoot}packages/shared/src/transport.ts`, 'utf8');
const singboxSrc = readFileSync(
  `${repoRoot}apps/node/internal/core/singbox/adapter.go`,
  'utf8',
);

/**
 * Keys the sing-box engine never reads, each with the reason it loses nothing.
 *
 * Only two reasons are admissible, and both are checked by a human reading the
 * renderer, not by this file: CLIENT means the value is a half the client uses
 * and the node was never given; GATED means the key is only meaningful under a
 * config value `xrayFamilyWire.toInboundConfig` refuses outright, so a profile
 * carrying it cannot be applied through this engine at all.
 */
const EXPLAINED_ABSENCES: Record<string, string> = {
  inboundId:
    'GATED-ish: one inbound per sing-box adapter. The id is the agent dispatcher argument (ApplyInbound), not part of the config blob it decodes.',
  tlsServerName: "GATED: only meaningful when security='tls', which toInboundConfig refuses.",
  tlsCert: "GATED: only meaningful when security='tls', which toInboundConfig refuses.",
  tlsKey: "GATED: only meaningful when security='tls', which toInboundConfig refuses.",
  tlsRejectUnknownSni:
    "GATED: the xray renderer writes it inside the tlsSettings block only, i.e. security='tls', which toInboundConfig refuses.",
  realityPublicKey:
    'CLIENT: the public half. It rides the share link; a REALITY inbound is configured with the private key alone.',
  realityFallbackUpstream:
    "GATED: only used by the local TLS fallback of realityMode='self-steal', which toInboundConfig refuses.",
  fingerprint:
    'CLIENT: the uTLS fingerprint the CLIENT presents. No server-side counterpart in either engine.',
  path: "GATED: ws/xhttp/httpupgrade only; toInboundConfig refuses any network but 'raw'.",
  host: "GATED: ws/xhttp/httpupgrade only; toInboundConfig refuses any network but 'raw'.",
  serviceName: "GATED: grpc only; toInboundConfig refuses any network but 'raw'.",
  xhttpMode: "GATED: xhttp only; toInboundConfig refuses any network but 'raw'.",
  xhttpPaddingBytes: "GATED: xhttp only; toInboundConfig refuses any network but 'raw'.",
  grpcMultiMode: "GATED: grpc only; toInboundConfig refuses any network but 'raw'.",
};

describe('sing-box engine coverage of the xray wire config', () => {
  it('reads or explains every key the panel can push', () => {
    const panelKeys = interfaceKeys(transportSrc, 'XrayInboundCfg');
    const agentKeys = new Set(goStructJsonTags(singboxSrc, 'xrayFamilyWire'));

    // Guard the mirror itself: a parse that quietly returns nothing would make
    // this test pass by knowing nothing.
    expect(panelKeys.length).toBeGreaterThan(20);
    expect(agentKeys.size).toBeGreaterThan(10);
    expect(panelKeys).toContain('realityPrivateKey');
    expect([...agentKeys]).toContain('realityPrivateKey');

    const unexplained = panelKeys.filter(
      (k) => !agentKeys.has(k) && !(k in EXPLAINED_ABSENCES),
    );
    expect(
      unexplained,
      `these XrayInboundCfg keys are pushed to the node and silently dropped by the sing-box engine. ` +
        `Either xrayFamilyWire must read them (or refuse them, as it does for cascade/warp/abusePolicy), ` +
        `or they belong in EXPLAINED_ABSENCES with the reason they lose nothing`,
    ).toEqual([]);
  });

  it('keeps no stale entry in the explanation list', () => {
    const panelKeys = new Set(interfaceKeys(transportSrc, 'XrayInboundCfg'));
    const agentKeys = new Set(goStructJsonTags(singboxSrc, 'xrayFamilyWire'));
    const stale = Object.keys(EXPLAINED_ABSENCES).filter(
      (k) => !panelKeys.has(k) || agentKeys.has(k),
    );
    expect(
      stale,
      'an explanation that outlived its key reads as a guarantee about a field nobody sends any more',
    ).toEqual([]);
  });

  // The keys the agent carries ONLY to refuse are worth naming twice: the agent
  // refusing them makes the push fail, and this list makes the operator hear it
  // while saving. Both halves, or the operator learns from a worker log.
  it('warns at save time about the profile-carried keys the engine refuses', () => {
    expect(
      fieldsUnsupportedByEngine('singbox', {
        abusePolicy: { blockTorrent: false, blockSmtp: true, blockDnsHijack: true },
        realityMldsa65Seed: 'seed',
        vlessDecryption: 'mlkem768x25519plus.native.600s',
        realityXver: 2,
        realityLimitFallbackUploadBytesPerSec: 131072,
        realityLimitFallbackDownloadBytesPerSec: 262144,
      }).sort(),
    ).toEqual(
      [
        'abusePolicy',
        'realityLimitFallbackDownloadBytesPerSec',
        'realityLimitFallbackUploadBytesPerSec',
        'realityMldsa65Seed',
        'realityXver',
        'vlessDecryption',
      ].sort(),
    );
  });

  // Zero is what the schema defaults these to, and a default is not a promise.
  it('says nothing about the off values the schema fills in by itself', () => {
    expect(
      fieldsUnsupportedByEngine('singbox', {
        realityXver: 0,
        realityLimitFallbackUploadBytesPerSec: 0,
        realityLimitFallbackDownloadBytesPerSec: 0,
      }),
    ).toEqual([]);
  });
});
