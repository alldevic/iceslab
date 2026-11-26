import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_SCRIPTS,
  CORE_VERSIONS,
  coreArtifactName,
  coreScriptName,
} from '@iceslab/shared';

/**
 * The routes a node takes its cores from. Everything here is about who gets
 * which bytes: no bearer, a forged one and a deleted node get nothing; a name
 * the manifest does not list never reaches the filesystem; an architecture the
 * image was not built with is a 404 that says how to get it.
 *
 * `CORES_DIR` is a temp directory, set before anything imports config (config
 * freezes its object on first import).
 */
const dir = mkdtempSync(join(tmpdir(), 'iceslab-cores-'));
process.env['CORES_DIR'] = dir;

let app: FastifyInstance;
let token: string;
let nodeId: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let signHeartbeatToken: typeof import('../nodes/heartbeat-token.js').signHeartbeatToken;

const XRAY = CORE_VERSIONS.xray.releases[0]!;
const XRAY_AMD64 = XRAY.assets!.amd64!;
const XRAY_FILE = coreArtifactName('xray', XRAY.version, 'amd64', XRAY_AMD64.file);
const SCRIPT = CORE_SCRIPTS['xray-install'];
const SCRIPT_FILE = coreScriptName('xray-install', SCRIPT);
// Not the real artifacts: the manifest's sha256 is a claim about the real file,
// and the header states the claim.
const BODY = Buffer.from('not really a proxy core, but it is bytes\n');
const SCRIPT_BODY = Buffer.from('#!/bin/sh\necho installer\n');

const XRAY_URL = `/api/internal/cores/xray/${XRAY.version}/amd64`;

let n = 0;
/** A fresh source address per request, so the limiter only trips where a case asks. */
const get = (url: string, headers?: Record<string, string>, remoteAddress?: string) =>
  app.inject({ method: 'GET', url, headers, remoteAddress: remoteAddress ?? `10.7.${Math.floor(++n / 250)}.${n % 250}` });
const bearer = () => ({ authorization: `Bearer ${token}` });

async function makeNode(opts: { status?: string; deleted?: boolean } = {}) {
  const secret = randomBytes(32);
  const node = await prisma.node.create({
    data: {
      name: `cores-${randomBytes(3).toString('hex')}`,
      address: `cores-${randomBytes(3).toString('hex')}.example.com:1337`,
      status: opts.status ?? 'online',
      deletedAt: opts.deleted ? new Date() : null,
      heartbeatSecret: secret,
    },
  });
  return { id: node.id as string, token: signHeartbeatToken(node.id, secret) };
}

beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  const [{ buildApp }, prismaMod, hb] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
    import('../nodes/heartbeat-token.js'),
  ]);
  prisma = prismaMod.prisma;
  signHeartbeatToken = hb.signHeartbeatToken;
  app = await buildApp();
});

beforeEach(async () => {
  const { cleanDatabase } = await import('../../../tests/helpers/db.js');
  await cleanDatabase();
  const node = await makeNode();
  nodeId = node.id;
  token = node.token;
  await writeFile(join(dir, XRAY_FILE), BODY);
  await writeFile(join(dir, SCRIPT_FILE), SCRIPT_BODY);
});

afterEach(async () => {
  await rm(join(dir, XRAY_FILE), { force: true });
  await rm(join(dir, SCRIPT_FILE), { force: true });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const ROUTES = ['/api/internal/cores', XRAY_URL, `/api/internal/cores/scripts/xray-install/${SCRIPT.ref}`];

describe('who may ask', () => {
  it.each(ROUTES)('refuses no bearer: %s', async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'MISSING_BEARER' });
  });

  it.each(ROUTES)('refuses a forged bearer: %s', async (url) => {
    const res = await get(url, { authorization: `Bearer ${nodeId}.${'0'.repeat(43)}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'INVALID_TOKEN' });
  });

  it('refuses the token of another panel (unknown node)', async () => {
    const other = signHeartbeatToken('00000000-0000-4000-8000-000000000000', randomBytes(32));
    const res = await get(XRAY_URL, { authorization: `Bearer ${other}` });
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)('tells a soft-deleted node 410 GONE: %s', async (url) => {
    const gone = await makeNode({ deleted: true });
    const res = await get(url, { authorization: `Bearer ${gone.token}` });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'GONE' });
  });

  it('serves a disabled node', async () => {
    const off = await makeNode({ status: 'disabled' });
    const res = await get(XRAY_URL, { authorization: `Bearer ${off.token}` });
    expect(res.statusCode).toBe(200);
  });
});

describe('what it hands over', () => {
  it('the file, byte for byte, with the manifest sha256 and the version', async () => {
    const res = await get(XRAY_URL, bearer());
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BODY)).toBe(true);
    expect(res.headers['x-iceslab-sha256']).toBe(XRAY_AMD64.sha256);
    expect(res.headers['x-iceslab-core-version']).toBe(XRAY.version);
    expect(res.headers['content-length']).toBe(String(BODY.length));
  });

  it('the pinned script, with its sha256 and ref', async () => {
    const res = await get(`/api/internal/cores/scripts/xray-install/${SCRIPT.ref}`, bearer());
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(SCRIPT_BODY)).toBe(true);
    expect(res.headers['x-iceslab-sha256']).toBe(SCRIPT.sha256);
    expect(res.headers['x-iceslab-core-version']).toBe(SCRIPT.ref);
  });

  it('the listing reflects the disk, not the manifest', async () => {
    const res = await get('/api/internal/cores', bearer());
    expect(res.statusCode).toBe(200);
    const { cores, scripts } = res.json() as {
      cores: { component: string; version: string; arch: string; file: string; sha256: string; carried: boolean }[];
      scripts: { name: string; ref: string; carried: boolean; sha256: string }[];
    };
    // The control: an empty list would make the rest vacuous.
    expect(cores.length).toBeGreaterThan(10);
    expect(cores.filter((c) => c.carried).map((c) => `${c.component}/${c.version}/${c.arch}`)).toEqual([
      `xray/${XRAY.version}/amd64`,
    ]);
    expect(cores.find((c) => c.component === 'xray' && c.arch === 'amd64')).toMatchObject({
      file: XRAY_AMD64.file,
      sha256: XRAY_AMD64.sha256,
    });
    expect(scripts).toEqual([
      { name: 'xray-install', ref: SCRIPT.ref, file: SCRIPT.file, sha256: SCRIPT.sha256, carried: true },
    ]);
    // Nothing in the listing is a component without files.
    expect(cores.some((c) => c.component === 'amneziawg-module' || c.component === 'caddy-naive')).toBe(false);

    await rm(join(dir, XRAY_FILE));
    const again = (await get('/api/internal/cores', bearer())).json() as { cores: { carried: boolean }[] };
    expect(again.cores.some((c) => c.carried)).toBe(false);
  });
});

describe('what it refuses, and whether it says why', () => {
  it.each([
    ['an unknown component', '/api/internal/cores/nginx/1.0/amd64'],
    ['an unknown version', '/api/internal/cores/xray/0.0.1/amd64'],
    ['a version with a leading v', `/api/internal/cores/xray/v${XRAY.version}/amd64`],
    ['an unknown arch', `/api/internal/cores/xray/${XRAY.version}/sparc`],
    ['a component built from a commit', '/api/internal/cores/amneziawg-module/3.1.20260906/amd64'],
    ['an arch upstream does not ship', `/api/internal/cores/mita/${CORE_VERSIONS.mita.releases[0]!.version}/armv7`],
    ['an unknown script', `/api/internal/cores/scripts/nope/${SCRIPT.ref}`],
    ['a script at another ref', '/api/internal/cores/scripts/xray-install/main'],
  ])('404 UNKNOWN_CORE for %s', async (_what, url) => {
    const res = await get(url, bearer());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_CORE' });
  });

  it('a manifest release the image was not built with is NOT_CARRIED and names CORE_ARCHES', async () => {
    const res = await get(`/api/internal/cores/xray/${XRAY.version}/arm64`, bearer());
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('NOT_CARRIED');
    expect(body.message).toContain('CORE_ARCHES');
    expect(body.message).toContain('arm64');
  });

  it('a script missing on disk is NOT_CARRIED', async () => {
    await rm(join(dir, SCRIPT_FILE));
    const res = await get(`/api/internal/cores/scripts/xray-install/${SCRIPT.ref}`, bearer());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NOT_CARRIED' });
  });

  it.each([
    '/api/internal/cores/..%2F..%2Fetc/passwd/amd64',
    `/api/internal/cores/xray/..%2F${XRAY.version}/amd64`,
    `/api/internal/cores/xray/${XRAY.version}/..%2F..%2Fxray`,
    '/api/internal/cores/xray/%2e%2e/amd64',
    '/api/internal/cores/scripts/xray-install/..%2Fx',
    '/api/internal/cores/scripts/..%2F..%2F/x',
  ])('a traversal never reaches the disk: %s', async (url) => {
    const res = await get(url, bearer());
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-iceslab-sha256']).toBeUndefined();
  });

  it('a file outside the cores directory is not served even if a name pointed there', async () => {
    // The sibling a `..` would reach if the parameter were used in the path.
    const outside = join(dir, '..', `outside-${randomBytes(3).toString('hex')}`);
    await writeFile(outside, 'secret');
    try {
      const res = await get(`/api/internal/cores/xray/${XRAY.version}/${encodeURIComponent(`../${outside.split('/').pop()}`)}`, bearer());
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret');
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe('the ceiling of its own', () => {
  it('answers the twenty-first request of a minute from one address with 429', async () => {
    const ip = '10.99.99.99';
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await get(XRAY_URL, bearer(), ip)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('the listing has the same ceiling', async () => {
    const ip = '10.99.99.98';
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await get('/api/internal/cores', bearer(), ip)).statusCode);
    expect(codes[20]).toBe(429);
  });
});
