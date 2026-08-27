import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_BINARIES } from '@iceslab/shared';

/**
 * The route a node takes its proxy core from.
 *
 * This is the download that replaces "fetch it from GitHub and install it
 * unverified". Everything it must get right is about REFUSAL, because the only
 * reason to move the download here was to stop a node ending up with bytes
 * nobody chose: an anonymous caller gets nothing, a name or architecture that
 * is not pinned gets nothing, and an architecture this image was not built
 * with gets a 404 that says which — the node installer stops there rather than
 * going back to GitHub.
 *
 * `CORES_DIR` is pointed at a temp directory before the app is built, so these
 * run against real files without an image.
 */

let app: FastifyInstance;
let token: string;
let nodeId: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const BODY = Buffer.from('not really a proxy core, but it is bytes\n');
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

/**
 * Created and pointed at BEFORE anything imports config: `config.ts` freezes
 * its object on first import, and `prisma.js` pulls it in, so a `CORES_DIR`
 * set inside `beforeEach` arrives too late and the route reads `/app/cores` —
 * which on a developer's machine is nothing, and every case here then passes
 * for the wrong reason or fails for a reason that is not the code's.
 */
const dir = mkdtempSync(join(tmpdir(), 'iceslab-cores-'));
process.env['CORES_DIR'] = dir;

beforeEach(async () => {
  const [{ buildApp }, prismaMod, { cleanDatabase }] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
    import('../../../tests/helpers/db.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await cleanDatabase();

  const { signHeartbeatToken } = await import('../nodes/heartbeat-token.js');
  const secret = randomBytes(32);
  const node = await prisma.node.create({
    data: {
      name: `cores-${Date.now()}`,
      address: 'cores.example.com:1337',
      heartbeatSecret: secret,
    },
  });
  nodeId = node.id;
  token = signHeartbeatToken(node.id, secret);
  await writeFile(join(dir, 'xray-amd64'), BODY);
});

afterEach(async () => {
  await app.close();
  await rm(join(dir, 'xray-amd64'), { force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

const bearer = () => ({ authorization: `Bearer ${token}` });
const get = (url: string, headers?: Record<string, string>) =>
  app.inject({ method: 'GET', url, headers });

describe('who may ask', () => {
  it('refuses a caller with no bearer', async () => {
    for (const url of ['/api/internal/cores', '/api/internal/cores/xray/amd64']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('refuses a forged bearer', async () => {
    const forged = `${nodeId}.${'0'.repeat(64)}`;
    const res = await get('/api/internal/cores/xray/amd64', { authorization: `Bearer ${forged}` });
    expect(res.statusCode).toBe(401);
  });

  it('serves the agent whose token it minted', async () => {
    const res = await get('/api/internal/cores/xray/amd64', bearer());
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BODY)).toBe(true);
  });
});

describe('what it hands over', () => {
  it('carries the pinned sha256 and version in headers, so the node need not ask twice', async () => {
    const res = await get('/api/internal/cores/xray/amd64', bearer());
    expect(res.headers['x-iceslab-sha256']).toBe(CORE_BINARIES.xray.assets.amd64!.sha256);
    expect(res.headers['x-iceslab-core-version']).toBe(CORE_BINARIES.xray.version);
    expect(res.headers['content-length']).toBe(String(BODY.length));
  });

  // The fixture is not a real core, so its bytes do NOT match the pinned sum -
  // and that is the point of the case above: the header states the PIN. What
  // ties the pin to the bytes is the panel's build, and image-selftest.sh asks
  // the built image whether they still agree.
  it('the header is the pin, not a hash of whatever is on disk', async () => {
    const res = await get('/api/internal/cores/xray/amd64', bearer());
    expect(res.headers['x-iceslab-sha256']).not.toBe(BODY_SHA);
  });

  it('lists what it carries, and marks what it does not', async () => {
    const res = await get('/api/internal/cores', bearer());
    expect(res.statusCode).toBe(200);
    const { cores } = res.json() as {
      cores: { name: string; arch: string; carried: boolean }[];
    };
    // The control: an empty list would make every assertion below vacuous.
    expect(cores.length).toBeGreaterThan(5);
    const carried = cores.filter((c) => c.carried);
    expect(carried.map((c) => `${c.name}-${c.arch}`)).toEqual(['xray-amd64']);
    // `carried` is read off the disk, not off the manifest: an image built for
    // fewer architectures than the manifest knows must say so.
    expect(cores.some((c) => !c.carried)).toBe(true);
  });
});

describe('what it refuses, and whether it says why', () => {
  it('404s a core nobody pinned', async () => {
    const res = await get('/api/internal/cores/nginx/amd64', bearer());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_CORE' });
  });

  it('404s an architecture nobody pinned', async () => {
    const res = await get('/api/internal/cores/xray/sparc', bearer());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_CORE' });
  });

  it('404s a pinned pair this image was not built with, and names the way out', async () => {
    // mita/armv7 is absent from the manifest itself (upstream ships armv7 only
    // as a tarball while the node installs a .deb), so it is UNKNOWN. The case
    // here is the other one: pinned, but not in this image.
    const res = await get('/api/internal/cores/xray/arm64', bearer());
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('NOT_CARRIED');
    expect(body.message).toContain('CORE_ARCHES');
    expect(body.message).toContain('arm64');
  });

  it('cannot be walked out of its directory', async () => {
    // Both params reach a filesystem path. They are matched against fixed
    // lists before they get there, and this is the case that says so.
    for (const url of [
      '/api/internal/cores/..%2F..%2Fetc/amd64',
      '/api/internal/cores/xray/..%2F..%2Fetc%2Fpasswd',
    ]) {
      const res = await get(url, bearer());
      expect([400, 404], url).toContain(res.statusCode);
    }
  });
});

describe('how often it may be asked', () => {
  /**
   * The reason this route needed a ceiling of its own: it answers with a FILE.
   * Under the app-wide 100/min a single bearer pulls ~2 GB of xray a minute,
   * and the two routes next to it in this family (bootstrap redeem, heartbeat)
   * both already had one — this one was written without and shipped that way.
   *
   * Asked by exhausting the bucket, not by reading the route options: a
   * `config.rateLimit` block can be present and still not apply (wrong plugin
   * scope, wrong option name), and only the built app knows which.
   */
  const limit = 20; // config.RATE_LIMIT_CORE_PER_MIN default; asserted below.

  it('stops a caller who keeps downloading, and stops well below the global 100/min', async () => {
    const codes: number[] = [];
    for (let i = 0; i < limit + 1; i += 1) {
      codes.push((await get('/api/internal/cores/xray/amd64', bearer())).statusCode);
    }
    expect(codes.slice(0, limit)).toEqual(Array(limit).fill(200));
    expect(codes[limit]).toBe(429);
    // The control. If the route had no ceiling of its own this would still
    // eventually 429 — at 100, the global one — so the number is the assertion.
    expect(limit).toBeLessThan(100);
  });

  it('applies the same ceiling to the listing beside it', async () => {
    let last = 0;
    for (let i = 0; i < limit + 1; i += 1) {
      last = (await get('/api/internal/cores', bearer())).statusCode;
    }
    expect(last).toBe(429);
  });

  it('counts the two routes separately, so a listing does not spend a download', async () => {
    for (let i = 0; i < limit; i += 1) await get('/api/internal/cores', bearer());
    const res = await get('/api/internal/cores/xray/amd64', bearer());
    expect(res.statusCode).toBe(200);
  });

  it('advertises the ceiling it enforces, and it is the configured one', async () => {
    const { config } = await import('../../config.js');
    const res = await get('/api/internal/cores/xray/amd64', bearer());
    expect(config.RATE_LIMIT_CORE_PER_MIN).toBe(limit);
    expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
  });
});
