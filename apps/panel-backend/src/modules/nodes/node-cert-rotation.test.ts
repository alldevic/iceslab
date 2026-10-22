import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { createSecureContext, type TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { bootstrapCa } from '../keygen/keygen.service.js';
import { generateNodeCert } from '../keygen/keygen.crypto.js';
import { closeNodeTransport, NodeTransport } from './nodes.transport.js';
import { renewExpiringNodeCerts, rotateNodeCert, sansOf } from './node-cert-rotation.js';
import { _resetHandshakeCertReadsForTest, parseCertNotAfter, pollNodeStatuses } from './nodes.cron.js';
import { mapNodeToPublic } from './nodes.mapper.js';

/**
 * A-124 on the panel side, against a stand-in agent that speaks the agent's
 * contract over real mTLS: /healthz, /rotateCert (serve the new pair to new
 * handshakes), /rotateCert/confirm (accepted only on a connection that was
 * served the new pair, which is what the panel has to prove).
 */
interface FakeAgent {
  server: Server;
  port: number;
  /** Fingerprints the confirms arrived for, with the leaf their own connection served. */
  confirms: { asked: string; servedOnThatConnection: string }[];
  /** Bodies of /rotateCert, without the key. */
  rotations: { certPem: string }[];
}

const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

async function fakeAgent(opts: {
  sans: { type: 'dns' | 'ip'; value: string }[];
  lifetimeMs?: number;
  /** A node that answers ok to /rotateCert but keeps serving the old leaf. */
  liesAboutRotation?: boolean;
  /** An agent older than rotation: 404, and no certNotAfter in /healthz. */
  noRotation?: boolean;
}): Promise<FakeAgent> {
  const ca = await bootstrapCa();
  const pair = await generateNodeCert(ca, { commonName: 'fake', sans: opts.sans, lifetimeMs: opts.lifetimeMs });
  const confirms: FakeAgent['confirms'] = [];
  const rotations: FakeAgent['rotations'] = [];
  let pending: string | null = null;
  let current = pair.certPem;
  const server = createServer(
    { cert: pair.certPem, key: pair.privateKeyPem, ca: ca.certPem, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/healthz') {
          return send(200, {
            status: 'ok',
            cores: [],
            ...(opts.noRotation ? {} : { certNotAfter: new Date(new X509Certificate(current).validTo).toISOString() }),
          });
        }
        if (opts.noRotation) return send(404, { error: 'NOT_FOUND', message: 'no route' });
        if (req.url === '/rotateCert') {
          const r = JSON.parse(body) as { certPem: string; keyPem: string };
          rotations.push({ certPem: r.certPem });
          if (pending) return send(409, { error: 'CERT_ROTATION_PENDING', message: 'pending' });
          createPrivateKey(r.keyPem); // a key that parses, as the agent checks the pair
          if (!opts.liesAboutRotation) {
            server.setSecureContext({ cert: r.certPem, key: r.keyPem, ca: ca.certPem });
            current = r.certPem;
          }
          pending = fp(r.certPem);
          return send(200, { ok: true, fingerprint: pending, confirmBy: new Date(Date.now() + 600_000).toISOString() });
        }
        if (req.url === '/rotateCert/confirm') {
          const asked = (JSON.parse(body) as { fingerprint: string }).fingerprint;
          const served = (req.socket as TLSSocket).getCertificate() as { raw?: Buffer } | null;
          const servedFp = served?.raw ? new X509Certificate(served.raw).fingerprint256.replace(/:/g, '').toLowerCase() : '';
          confirms.push({ asked, servedOnThatConnection: servedFp });
          if (asked !== pending) return send(409, { error: 'CERT_NOT_PENDING', message: 'not pending' });
          pending = null;
          return send(200, { ok: true });
        }
        return send(404, { error: 'NOT_FOUND', message: req.url });
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, confirms, rotations };
}

async function nodeAt(port: number, extra: Record<string, unknown> = {}): Promise<string> {
  return (
    await prisma.node.create({
      data: {
        name: `cert-${port}`,
        address: `127.0.0.1:${port}`,
        protocol: 'xray',
        heartbeatSecret: randomBytes(32),
        status: 'online',
        ...extra,
      },
      select: { id: true },
    })
  ).id;
}

const agents: FakeAgent[] = [];
beforeEach(async () => {
  await cleanDatabase();
  // The shared agent holds the CA of the previous test's database.
  await closeNodeTransport();
  _resetHandshakeCertReadsForTest();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of agents.splice(0)) a.server.close();
});
afterAll(async () => {
  await closeNodeTransport();
  await prisma.$disconnect();
  await closeRedis();
});

describe('rotateNodeCert', () => {
  it('hands the node a new pair, confirms it from a connection that was served it, and stores its end', async () => {
    const a = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }, { type: 'dns', value: 'old-name.example' }] });
    agents.push(a);
    const id = await nodeAt(a.port);

    const out = await rotateNodeCert(id, { lifetimeMs: 3 * 24 * 3600_000 });

    expect(a.rotations).toHaveLength(1);
    const issued = new X509Certificate(a.rotations[0]!.certPem);
    // Every name the old leaf carried, so the agent's check passes.
    expect(issued.subjectAltName).toContain('DNS:old-name.example');
    expect(issued.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(out.fingerprint).toBe(fp(a.rotations[0]!.certPem));
    // The confirm came from a connection that was served THE NEW leaf.
    expect(a.confirms).toEqual([{ asked: out.fingerprint, servedOnThatConnection: out.fingerprint }]);
    // The lifetime parameter, and the end is stored.
    const lifetime = new Date(out.notAfter).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(3 * 24 * 3600_000 - 60_000);
    expect(lifetime).toBeLessThanOrEqual(3 * 24 * 3600_000);
    const row = await prisma.node.findUniqueOrThrow({ where: { id }, select: { certNotAfter: true } });
    expect(row.certNotAfter?.toISOString()).toBe(out.notAfter);
  });

  it('never confirms when the node keeps presenting the old leaf: the agent rolls back by itself', async () => {
    const a = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }], liesAboutRotation: true });
    agents.push(a);
    const id = await nodeAt(a.port);
    await expect(rotateNodeCert(id)).rejects.toMatchObject({ code: 'UNCONFIRMED' });
    // Refused at the handshake: the confirm request never reached the node.
    expect(a.confirms).toEqual([]);
    const row = await prisma.node.findUniqueOrThrow({ where: { id }, select: { certNotAfter: true } });
    expect(row.certNotAfter).toBeNull();
  });

  it('an agent without rotation reads as "update the agent"', async () => {
    const a = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }], noRotation: true });
    agents.push(a);
    await expect(rotateNodeCert(await nodeAt(a.port))).rejects.toMatchObject({ code: 'UPDATE_AGENT' });
  });

  it('a rotation still waiting for its confirm is PENDING, and no key travels in the error', async () => {
    const a = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }], liesAboutRotation: true });
    agents.push(a);
    const id = await nodeAt(a.port);
    await rotateNodeCert(id).catch(() => undefined);
    const err = (await rotateNodeCert(id).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('PENDING');
    expect(err.message).not.toContain('PRIVATE KEY');
  });
});

describe('renewal ahead of the end', () => {
  it('renews a live node within 30 days of its end and leaves one further out alone', async () => {
    const soon = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }] });
    const later = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }] });
    agents.push(soon, later);
    const day = 24 * 3600_000;
    const soonId = await nodeAt(soon.port, { certNotAfter: new Date(Date.now() + 10 * day) });
    await nodeAt(later.port, { certNotAfter: new Date(Date.now() + 60 * day) });
    // Down and due: not tried, it would only fail.
    await nodeAt(65000, { status: 'unreachable', certNotAfter: new Date(Date.now() + day) });

    expect(await renewExpiringNodeCerts()).toEqual({ renewed: 1, failed: 0 });
    expect(soon.rotations).toHaveLength(1);
    expect(later.rotations).toHaveLength(0);
    const row = await prisma.node.findUniqueOrThrow({ where: { id: soonId }, select: { certNotAfter: true } });
    expect(row.certNotAfter!.getTime()).toBeGreaterThan(Date.now() + 300 * day);
  });
});

describe('the status poll keeps the end the agent reports', () => {
  it('writes certNotAfter from /healthz and keeps it when an older agent says nothing', async () => {
    const id = await nodeAt(1);
    const end = '2027-10-01T00:00:00Z';
    const spy = vi
      .spyOn(NodeTransport.prototype, 'healthcheck')
      .mockResolvedValue({ status: 'ok', cores: [], certNotAfter: end } as never);
    await pollNodeStatuses();
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).certNotAfter?.toISOString()).toBe(
      '2027-10-01T00:00:00.000Z',
    );
    spy.mockResolvedValue({ status: 'ok', cores: [] } as never);
    await pollNodeStatuses();
    expect((await prisma.node.findUniqueOrThrow({ where: { id } })).certNotAfter?.toISOString()).toBe(
      '2027-10-01T00:00:00.000Z',
    );
  });

  it('an agent that does not report the end: read off the handshake, and the node says it cannot rotate (A-221)', async () => {
    const day = 24 * 3600_000;
    const old = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }], noRotation: true, lifetimeMs: 20 * day });
    const fresh = await fakeAgent({ sans: [{ type: 'ip', value: '127.0.0.1' }], lifetimeMs: 200 * day });
    agents.push(old, fresh);
    const oldId = await nodeAt(old.port);
    const freshId = await nodeAt(fresh.port);
    await pollNodeStatuses();

    const o = await prisma.node.findUniqueOrThrow({ where: { id: oldId } });
    expect(o.certFromHandshake).toBe(true);
    expect(Math.abs(o.certNotAfter!.getTime() - (Date.now() + 20 * day))).toBeLessThan(60_000);
    expect(mapNodeToPublic(o)).toMatchObject({ certNotAfter: o.certNotAfter!.toISOString(), agentCanRotate: false });

    const f = await prisma.node.findUniqueOrThrow({ where: { id: freshId } });
    expect(f.certFromHandshake).toBe(false);
    expect(mapNodeToPublic(f).agentCanRotate).toBe(true);

    // Due within 30 days, but the cron does not ask an agent that cannot rotate.
    expect(await renewExpiringNodeCerts()).toEqual({ renewed: 0, failed: 0 });
    expect(old.rotations).toHaveLength(0);
  });

  it('reads the field strictly', () => {
    expect(parseCertNotAfter(undefined)).toBeUndefined();
    expect(parseCertNotAfter('garbage')).toBeUndefined();
    expect(parseCertNotAfter('2027-01-02T03:04:05Z')?.toISOString()).toBe('2027-01-02T03:04:05.000Z');
  });
});

describe('sansOf', () => {
  it('reads the names Node lists for a peer', () => {
    expect(sansOf('DNS:a.example, IP Address:1.2.3.4, URI:x')).toEqual([
      { type: 'dns', value: 'a.example' },
      { type: 'ip', value: '1.2.3.4' },
    ]);
    expect(sansOf('')).toEqual([]);
  });
});
