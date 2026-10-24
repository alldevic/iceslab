import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import type { TemplateType } from '@iceslab/shared';
import type { SubscriptionEndpoint } from '../subscription/subscription.formats.js';
import { readFrame } from '../subscription/subscription.frames.js';
import { buildClashYaml } from '../subscription/formats/clash.js';
import { buildSingboxJson } from '../subscription/formats/singbox.js';
import { buildXrayJson, buildXrayJsonArray } from '../subscription/formats/xrayjson.js';
import { checkTemplateBody } from './templates.parse.js';

const run = promisify(execFile);

/**
 * A-236 step 3: POST /api/subscription-templates/dry-run, the API contract
 * 4.5a. The body is filled with three synthetic nodes the way a subscription
 * is, and the result is shown with what the core says about it and what the
 * panel has to say:
 *   - `rendered`: the file a client would get;
 *   - `check`: `sing-box check` for sing-box, `xray -test` for the xray
 *     types (every element of the array); the Clash family has no core on the
 *     panel to ask, and a core the panel does not have is said so;
 *   - `warnings`: no node reached the file, or no group holds a node (the
 *     operator saved a frame without a slot and every client gets nothing).
 * `check.ok` is true when the core took the file, false when it refused it,
 * and null when it did not run (no binary on the panel, no Clash core at
 * all): null is not yes: the core did not run. The overall `ok` is false on a
 * refusal or any warning, null when nothing was refused and nothing checked,
 * true only when the core took it and there is no warning.
 */

export type CheckAnswer = { ok: boolean | null; message?: string };

export interface DryRun {
  ok: boolean | null;
  rendered: string;
  check: CheckAnswer;
  warnings: string[];
}

function overall(check: CheckAnswer, warnings: string[]): boolean | null {
  if (check.ok === false || warnings.length > 0) return false;
  return check.ok === null ? null : true;
}

const KEY = 'Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBLjyFlw';
const UUID = '11111111-1111-4111-8111-111111111111';

/** Three nodes of the kinds most subscriptions carry. */
export const DRY_RUN_NODES = [
  {
    nodeId: 'dry-1', port: 443, protocol: 'xray', nodeName: 'dry-run-1', host: 'node-1.example.com', uri: '',
    uuid: UUID, publicKey: KEY, shortId: '0123abcd', sni: 'www.example.com', flow: 'xtls-rprx-vision',
    fingerprint: 'chrome', network: 'raw', subprotocol: 'vless', securityLayer: 'default',
  },
  {
    nodeId: 'dry-2', port: 443, protocol: 'xray', nodeName: 'dry-run-2', host: 'node-2.example.com', uri: '',
    uuid: UUID, publicKey: '', shortId: '', sni: 'node-2.example.com', flow: '', fingerprint: 'chrome',
    network: 'ws', path: '/ws', subprotocol: 'trojan', securityLayer: 'tls',
  },
  { nodeId: 'dry-3', port: 443, protocol: 'hysteria', nodeName: 'dry-run-3', host: 'node-3.example.com', uri: '', password: 'dry-run' },
] as unknown as SubscriptionEndpoint[];

function binary(env: string | undefined, paths: string[]): string {
  return env ?? paths.find((p) => existsSync(p)) ?? '';
}

async function coreCheck(bin: string, args: (f: string) => string[], configs: string[], name: string): Promise<CheckAnswer> {
  if (!bin) return { ok: null, message: `not checked: no ${name} binary on the panel` };
  const dir = await mkdtemp(join(tmpdir(), 'iceslab-dry-'));
  try {
    for (const [i, c] of configs.entries()) {
      const file = join(dir, `config-${i}.json`);
      await writeFile(file, c);
      try {
        await run(bin, args(file), { timeout: 15_000 });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const said = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || String(e.message);
        return { ok: false, message: configs.length > 1 ? `element ${i + 1}: ${said}` : said };
      }
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function dryRun(type: TemplateType, body: string): Promise<DryRun> {
  checkTemplateBody(type, body);
  const frame = readFrame(type, body);
  const names = DRY_RUN_NODES.map((n) => n.nodeName);
  const warnings: string[] = [];

  if (type === 'mihomo' || type === 'stash' || type === 'clash') {
    const rendered = buildClashYaml(DRY_RUN_NODES, { frame });
    const doc = (parseYaml(rendered) ?? {}) as { proxies?: { name?: string }[]; 'proxy-groups'?: { proxies?: string[] }[] };
    if (!(doc.proxies ?? []).some((p) => names.some((n) => String(p?.name ?? '').startsWith(n)))) {
      warnings.push('no node reached `proxies`: every client would get an empty list');
    }
    if (!(doc['proxy-groups'] ?? []).some((g) => (g?.proxies ?? []).some((m) => names.some((n) => String(m).startsWith(n))))) {
      warnings.push('no proxy group holds a node: rules have nothing to send traffic through');
    }
    const check: CheckAnswer = { ok: null, message: 'not checked: the panel carries no mihomo core' };
    return { ok: overall(check, warnings), rendered, check, warnings };
  }

  if (type === 'singbox') {
    const rendered = buildSingboxJson(DRY_RUN_NODES, { frame });
    const cfg = JSON.parse(rendered) as { outbounds?: { type?: string; outbounds?: string[] }[] };
    const groups = (cfg.outbounds ?? []).filter((o) => o.type === 'selector' || o.type === 'urltest');
    if (!groups.some((g) => (g.outbounds ?? []).some((m) => names.some((n) => m.startsWith(n))))) {
      warnings.push('no selector or urltest group holds a node: the client cannot pick a server');
    }
    const bin = binary(process.env.SINGBOX_BIN, ['/usr/local/bin/sing-box', '/usr/bin/sing-box']);
    const check = await coreCheck(bin, (f) => ['check', '-c', f], [rendered], 'sing-box');
    return { ok: overall(check, warnings), rendered, check, warnings };
  }

  const rendered = type === 'xray-json' ? buildXrayJson(DRY_RUN_NODES, { frame }) : buildXrayJsonArray(DRY_RUN_NODES, { frame });
  const parsed = JSON.parse(rendered) as unknown;
  const configs = (Array.isArray(parsed) ? parsed : [parsed]).map((c) => JSON.stringify(c));
  const bin = binary(process.env.XRAY_BIN, ['/usr/local/bin/xray', '/usr/bin/xray']);
  const check = await coreCheck(bin, (f) => ['-test', '-c', f], configs, 'xray');
  return { ok: overall(check, warnings), rendered, check, warnings };
}
