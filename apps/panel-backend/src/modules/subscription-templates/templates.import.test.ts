import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TEMPLATE_TYPES, type TemplateType } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { importTemplate } from './templates.import.js';
import { TemplateInvalidError } from './templates.parse.js';
import { dryRun } from './templates.dryrun.js';
import { invalidateTemplateCache } from './templates.service.js';

/**
 * A-236 step 8: a template file taken in as a draft, its body byte for byte,
 * checked like any body of its type.
 */

/** The shapes operators' Clash-family templates use: our key on top, in a
 *  group and in a provider, comments, anchors and a merge key. */
const MIHOMO = `iceslab:
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
    iceslab:
      include-proxies: true

proxy-groups:
  - name: VPN
    type: select
    proxies:
      - Fastest
      # LEAVE THIS LINE!
  - name: Fastest
    iceslab:
      include-proxies: true
    type: url-test
    proxies: # LEAVE THIS LINE!

proxies: # LEAVE THIS LINE!

rules:
  - MATCH,VPN
`;

const SINGBOX = `{
  "iceslab": { "includeHiddenHosts": true },
  "outbounds": [
    { "type": "selector", "tag": "proxy", "outbounds": [] },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "final": "proxy" }
}
`;

const refusal = (fn: () => unknown): TemplateInvalidError => {
  try {
    fn();
  } catch (e) {
    return e as TemplateInvalidError;
  }
  throw new Error('no refusal');
};

describe('importTemplate', () => {
  it('hands the body back byte for byte, comments, anchors and the merge key included', () => {
    const d = importTemplate(MIHOMO, 'mihomo');
    expect(d).toEqual({ body: MIHOMO, type: 'mihomo', rewrittenKeys: 0 });
  });

  it('a YAML without a type comes back with none: mihomo, stash and clash read the same text', () => {
    expect(importTemplate(MIHOMO).type).toBeNull();
  });

  it('JSON: sing-box by its outbounds\' type; an xray JSON says nothing of which of the two it is', () => {
    expect(importTemplate(SINGBOX)).toMatchObject({ type: 'singbox', body: SINGBOX });
    expect(importTemplate('{ "log": {}, "outbounds": [ { "protocol": "freedom", "tag": "direct" } ] }').type).toBeNull();
  });

  it('checks even without a type: a service key we do not read is refused with its line', () => {
    const err = refusal(() => importTemplate('proxies:\niceslab:\n  extra: 1\n'));
    expect(err).toBeInstanceOf(TemplateInvalidError);
    expect(err.line).toBe(3);
    expect(refusal(() => importTemplate('{ "iceslab": { "injectHosts": [] }, "outbounds": [] }')).message).toMatch(
      /iceslab\.injectHosts is not a key the panel reads here/,
    );
    expect(refusal(() => importTemplate('{ "outbounds": [ }')).message).toMatch(/not valid JSON/);
  });

  it('a type that is not the file\'s language is said', () => {
    expect(() => importTemplate(SINGBOX, 'mihomo')).toThrow('a mihomo template is YAML, and this file is JSON');
  });

  it('the draft fills: the dry-run nodes in the proxies and in the group that asks', async () => {
    const run = await dryRun('mihomo', importTemplate(MIHOMO, 'mihomo').body);
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
    expect(out).toEqual({ template: { type: 'stash', name: '', body: MIHOMO, isDefault: false }, rewrittenKeys: 0 });
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
      payload: { body: 'proxies:\niceslab:\n  extra: 1\n', type: 'mihomo' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'TEMPLATE_INVALID', line: 3 });
  });
});

/**
 * Real operators' templates, as the migration tool writes them
 * (`iceslab-migrate templates`): a folder of `<type>--<name>.yaml|json` files
 * already carrying our key, in TEMPLATE_FILES_DIR. Not vendored here: the
 * catalogue they come from carries no licence. Without the folder the cases
 * skip, as the core checks skip without XRAY_BIN.
 */
const DIR = process.env.TEMPLATE_FILES_DIR;
const files = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => /^[a-z-]+--.+\.(ya?ml|json)$/.test(f)) : [];

describe.skipIf(files.length === 0)('template files from the migration tool (TEMPLATE_FILES_DIR)', () => {
  for (const file of files) {
    it(`${file}: imports and fills`, async () => {
      const type = file.split('--')[0] as TemplateType;
      expect(TEMPLATE_TYPES).toContain(type);
      const d = importTemplate(readFileSync(join(DIR!, file), 'utf8'), type);
      const run = await dryRun(type, d.body);
      // The core's answer where the panel has one (sing-box, xray); an
      // unchecked file is not a failure. One refusal is known and is the
      // file's, not the import's: sing-box templates that write DNS servers in
      // the form sing-box 1.12 deprecated, on which 1.13 stops unless
      // ENABLE_DEPRECATED_LEGACY_DNS_SERVERS is set (seen 25.10 with the
      // pinned 1.13.14). The dry run says so in the core's words; any other
      // refusal fails here.
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
