import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { bootstrapCa } from '../keygen/keygen.service.js';
import { generateNodeCert } from '../keygen/keygen.crypto.js';
import { closeNodeTransport, NodeTransport } from './nodes.transport.js';
import { rotateNodeCert } from './node-cert-rotation.js';

/**
 * 19.15, item 6: a node installed by IPv4 and moved to its IPv6 address.
 *
 * The node's mTLS pair names the address it was installed at, and the panel
 * checks the name on every call. After the move the panel dialled an address the
 * pair does not carry, the check refused, and the rotation that would have added
 * the name needed that very connection: 502 CERT_UNREACHABLE with the reason
 * hidden behind "fetch failed". The pair is now issued over the address that
 * still works, and only then is the address saved.
 */
interface Agent {
  server: Server;
  port: number;
  /** The node's stored address at the moment each /rotateCert arrived. */
  addressWhenRotated: (string | undefined)[];
  rotations: { certPem: string }[];
}

let nodeIdOfAgent = '';
const agents: Agent[] = [];

/** Listens on `::`, so both 127.0.0.1 and ::1 reach it; its first pair names 127.0.0.1 only. */
async function agent(): Promise<Agent> {
  const ca = await bootstrapCa();
  const pair = await generateNodeCert(ca, { commonName: 'fake', sans: [{ type: 'ip', value: '127.0.0.1' }] });
  const a: Agent = { server: undefined as never, port: 0, addressWhenRotated: [], rotations: [] };
  let pending: string | null = null;
  const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
  a.server = createServer(
    { cert: pair.certPem, key: pair.privateKeyPem, ca: ca.certPem, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/healthz') return send(200, { status: 'ok', cores: [] });
        if (req.url === '/rotateCert') {
          const r = JSON.parse(body) as { certPem: string; keyPem: string };
          a.rotations.push({ certPem: r.certPem });
          a.addressWhenRotated.push(
            (await prisma.node.findUnique({ where: { id: nodeIdOfAgent }, select: { address: true } }))?.address,
          );
          createPrivateKey(r.keyPem);
          a.server.setSecureContext({ cert: r.certPem, key: r.keyPem, ca: ca.certPem });
          pending = fp(r.certPem);
          return send(200, { ok: true, fingerprint: pending, confirmBy: new Date(Date.now() + 600_000).toISOString() });
        }
        if (req.url === '/rotateCert/confirm') {
          const asked = (JSON.parse(body) as { fingerprint: string }).fingerprint;
          const served = (req.socket as TLSSocket).getCertificate() as { raw?: Buffer } | null;
          if (asked !== pending || !served?.raw) return send(409, { error: 'CERT_NOT_PENDING', message: 'not pending' });
          pending = null;
          return send(200, { ok: true });
        }
        return send(404, { error: 'NOT_FOUND', message: req.url });
      });
    },
  );
  await new Promise<void>((r) => a.server.listen(0, '::', r));
  a.port = (a.server.address() as AddressInfo).port;
  agents.push(a);
  return a;
}

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  await closeNodeTransport();
  token = await registerAndLogin(app);
  stubNodeRoster();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of agents.splice(0)) a.server.close();
  await app.close();
});
afterAll(async () => {
  await closeNodeTransport();
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

let named = 0;
async function nodeAt(address: string, status = 'online'): Promise<string> {
  const n = await prisma.node.create({
    data: { name: `moved-node-${++named}`, address, protocol: 'xray', heartbeatSecret: randomBytes(32), status },
    select: { id: true },
  });
  nodeIdOfAgent = n.id;
  return n.id;
}

const put = (id: string, address: string) =>
  app.inject({ method: 'PUT', url: `/api/nodes/${id}`, headers: auth(), payload: { address } });

describe('the cause of the 502 (reproduction)', () => {
  it('the name check refuses an address the pair does not carry, and the rotation says so', async () => {
    const a = await agent();
    const id = await nodeAt(`[::1]:${a.port}`);

    const err = (await new NodeTransport({ address: `[::1]:${a.port}` }).presentedCert().catch((e: unknown) => e)) as Error;
    expect((err.cause as { code?: string }).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');

    // What the operator was shown was "fetch failed"; now the reason.
    const rotation = await rotateNodeCert(id).catch((e: unknown) => e);
    expect(rotation).toMatchObject({ code: 'UNREACHABLE' });
    expect((rotation as Error).message).toMatch(/does not name the address the panel dials/);
    expect((rotation as Error).message).not.toMatch(/fetch failed$/);
  });
});

describe('saving a new address', () => {
  it('issues the pair over the old address first, and saves the new one after it', async () => {
    const a = await agent();
    const id = await nodeAt(`127.0.0.1:${a.port}`);

    const res = await put(id, `[::1]:${a.port}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).warnings).toBeUndefined();

    // Certificate first: when the node received the pair the row still had the old address.
    expect(a.addressWhenRotated).toEqual([`127.0.0.1:${a.port}`]);
    const issued = new X509Certificate(a.rotations[0]!.certPem);
    expect(issued.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(issued.subjectAltName).toMatch(/IP Address:0:0:0:0:0:0:0:1/i);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).address).toBe(`[::1]:${a.port}`);

    // And the node is reachable at the new address without anyone's help.
    const presented = await new NodeTransport({ address: `[::1]:${a.port}` }).presentedCert();
    expect(presented.subjectAltName).toMatch(/0:0:0:0:0:0:0:1/i);
    // The rotation worked again from there (the 200 of cert/rotate).
    await expect(rotateNodeCert(id)).resolves.toMatchObject({ fingerprint: expect.any(String) });
  });

  it('a node that cannot be asked keeps the save, and the answer says what was not done', async () => {
    const a = await agent();
    const port = a.port;
    a.server.close();
    const id = await nodeAt(`127.0.0.1:${port}`);

    const res = await put(id, `[::1]:${port}`);
    expect(res.statusCode, res.body).toBe(200);
    const warning = JSON.parse(res.body).warnings?.[0];
    expect(warning.code).toBe('CERT_NOT_PREPARED');
    expect(warning.message).toMatch(/certificate may not contain the new address/);
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).address).toBe(`[::1]:${port}`);
  });

  it('a node that was down since it was installed is saved with the same warning', async () => {
    const id = await nodeAt('127.0.0.1:65001', 'unreachable');
    const res = await put(id, '[::1]:65001');
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).warnings).toMatchObject([{ code: 'CERT_NOT_PREPARED' }]);
  });

  it('asks nothing when the name stays (a port edit) or the node was never installed', async () => {
    const a = await agent();
    const id = await nodeAt(`127.0.0.1:${a.port}`);
    const same = await put(id, `127.0.0.1:${a.port + 1}`);
    expect(same.statusCode, same.body).toBe(200);
    expect(JSON.parse(same.body).warnings).toBeUndefined();

    const fresh = await nodeAt(`127.0.0.1:${a.port}`, 'unknown');
    const res = await put(fresh, `[::1]:${a.port}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).warnings).toBeUndefined();
    expect(a.rotations).toHaveLength(0);
  });
});
