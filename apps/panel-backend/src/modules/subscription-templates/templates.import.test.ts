import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TemplateType } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { importTemplate, SOURCE_SERVICE_KEY } from './templates.import.js';
import { TemplateInvalidError } from './templates.parse.js';
import { dryRun } from './templates.dryrun.js';
import { invalidateTemplateCache } from './templates.service.js';

/**
 * A-236 step 8: a template of the panel operators move from, its service key
 * renamed in the text and nothing else touched.
 */

const K = SOURCE_SERVICE_KEY;

/** The shapes their Clash-family templates use: the key on top, in a group
 *  and in a provider, comments, anchors and a merge key. */
const MIHOMO = `${K}:
  includeHiddenHosts: false

x-anchors:
  pr_http: &pr_http
    type: http
    interval: 86400

mixed-port: 7890
proxy-providers:
  extra:
    <<: *pr_http
    url: https://example.com/p.yaml
    ${K}:
      include-proxies: true

proxy-groups:
  - name: VPN
    type: select
    proxies:
      - Fastest
      # LEAVE THIS LINE!
  - name: Fastest
    ${K}:
      include-proxies: true
    type: url-test
    proxies: # LEAVE THIS LINE!

proxies: # LEAVE THIS LINE!

rules:
  - MATCH,VPN
`;

const SINGBOX = `{
  "${K}": { "includeHiddenHosts": true },
  "outbounds": [
    { "type": "selector", "tag": "proxy", "outbounds": [] },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "final": "proxy" }
}
`;

describe('importTemplate', () => {
  it('renames the key at the top, in a group and in a provider, and leaves every other byte', () => {
    const d = importTemplate(MIHOMO, 'mihomo');
    expect(d.rewrittenKeys).toBe(3);
    expect(d.type).toBe('mihomo');
    expect(d.body).toBe(MIHOMO.split(`${K}:`).join('iceslab:'));
    // Comments, anchors and the merge key are the operator's, as written.
    expect(d.body).toContain('# LEAVE THIS LINE!');
    expect(d.body).toContain('<<: *pr_http');
    expect(d.body).not.toContain(K);
  });

  it('a YAML without a type comes back with none: mihomo, stash and clash read the same text', () => {
    expect(importTemplate(MIHOMO).type).toBeNull();
  });

  it('JSON: the quoted key keeps its quotes, and sing-box is told from xray by its outbounds', () => {
    const d = importTemplate(SINGBOX);
    expect(d.type).toBe('singbox');
    expect(d.rewrittenKeys).toBe(1);
    expect(d.body).toBe(SINGBOX.replace(`"${K}"`, '"iceslab"'));
    expect(JSON.parse(d.body)).toMatchObject({ iceslab: { includeHiddenHosts: true } });
    const xray = importTemplate('{ "log": {}, "outbounds": [ { "protocol": "freedom", "tag": "direct" } ] }');
    expect(xray).toMatchObject({ type: 'xray-json-array', rewrittenKeys: 0 });
  });

  it('a key where this panel reads none is refused with its line, not carried', () => {
    const body = `proxies:\nrules:\n  - MATCH,DIRECT\ndns:\n  ${K}:\n    x: 1\n`;
    const err = (() => { try { importTemplate(body, 'mihomo'); } catch (e) { return e; } })() as TemplateInvalidError;
    expect(err).toBeInstanceOf(TemplateInvalidError);
    expect(err.line).toBe(5);
    expect(err.message).toContain("source panel's service key");
  });

  it('what the key says is checked like any body: a part this panel has not got is refused', () => {
    const body = `{ "${K}": { "injectHosts": [] }, "outbounds": [ { "protocol": "freedom" } ] }`;
    expect(() => importTemplate(body)).toThrow(/iceslab\.injectHosts is not a key the panel reads here/);
  });

  it('a type that is not the file\'s language is said', () => {
    expect(() => importTemplate(SINGBOX, 'mihomo')).toThrow('a mihomo template is YAML, and this file is JSON');
  });

  it('the draft fills: three dry-run nodes in the proxies and in the group that asks', async () => {
    const d = importTemplate(MIHOMO, 'mihomo');
    const run = await dryRun('mihomo', d.body);
    expect(run.ok).not.toBe(false);
    const doc = parseYaml(run.rendered) as { proxies: { name: string }[]; 'proxy-groups': { name: string; proxies?: string[] }[] };
    expect(doc.proxies.length).toBeGreaterThan(0);
    const fastest = doc['proxy-groups'].find((g) => g.name === 'Fastest')!;
    expect(fastest.proxies).toEqual(doc.proxies.map((p) => p.name));
    expect(run.rendered).not.toContain('iceslab');
  });
});

describe('POST /api/subscription-templates/import', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    await cleanDatabase();
    invalidateTemplateCache();
    token = await registerAndLogin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('answers the draft and saves nothing; the draft then saves as any template', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/subscription-templates/import', headers: auth(), payload: { body: MIHOMO, type: 'stash' } });
    expect(res.statusCode, res.body).toBe(200);
    const out = JSON.parse(res.body) as { template: { type: string; name: string; body: string; isDefault: boolean }; rewrittenKeys: number };
    expect(out).toMatchObject({ template: { type: 'stash', name: '', isDefault: false }, rewrittenKeys: 3 });
    expect(await prisma.subscriptionTemplate.count()).toBe(0);
    const saved = await app.inject({
      method: 'POST', url: '/api/subscription-templates', headers: auth(),
      payload: { type: 'stash', name: 'ru-bundle', body: out.template.body },
    });
    expect(saved.statusCode, saved.body).toBe(201);
  });

  it('a refusal is TEMPLATE_INVALID with its line', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/subscription-templates/import', headers: auth(),
      payload: { body: `proxies:\ndns:\n  ${K}: {}\n`, type: 'mihomo' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'TEMPLATE_INVALID', line: 3 });
  });
});

/**
 * The operators' own templates, when a copy of their catalogue is at hand
 * (TEMPLATES_REF_DIR, the folder holding by-legiz/). Not vendored: the
 * catalogue carries no licence. Without it the cases skip, as the core checks
 * skip without XRAY_BIN.
 */
const REF = process.env.TEMPLATES_REF_DIR;
const REF_DIR = REF ? join(REF, 'by-legiz', 'subscription-templates') : '';
const typeOf = (file: string): TemplateType =>
  file.startsWith('mihomo') ? 'mihomo' : file.startsWith('stash') ? 'stash' : file.startsWith('singbox') ? 'singbox' : 'xray-json-array';

describe.skipIf(!REF || !existsSync(REF_DIR))('the catalogue templates (TEMPLATES_REF_DIR)', () => {
  const files = REF && existsSync(REF_DIR) ? readdirSync(REF_DIR).filter((f) => /\.(ya?ml|json)$/.test(f)) : [];
  for (const file of files) {
    it(`${file}: imports and fills`, async () => {
      const body = readFileSync(join(REF_DIR, file), 'utf8');
      const type = typeOf(file);
      const d = importTemplate(body, type);
      expect(d.body).not.toMatch(new RegExp(`^\\s*"?${K}"?:`, 'm'));
      const run = await dryRun(type, d.body);
      // The core's answer where the panel has one (sing-box, xray); an
      // unchecked file is not a failure. One refusal is known and is the
      // file's, not the import's: the catalogue's sing-box templates write DNS
      // servers in the form sing-box 1.12 deprecated, and 1.13 stops on it
      // unless ENABLE_DEPRECATED_LEGACY_DNS_SERVERS is set (seen 25.10 with
      // the pinned 1.13.14). The dry run says so to the operator in the
      // core's words; any other refusal fails here.
      if (run.check.ok === false) {
        expect(type, run.check.message).toBe('singbox');
        expect(run.check.message).toMatch(/legacy DNS servers is deprecated/);
      }
      expect(run.rendered.length).toBeGreaterThan(0);
      // xray -test on a 110 KB routing bundle, three times (one per dry-run
      // node), took past the default 20 s beside other files.
    }, 120_000);
  }
});
