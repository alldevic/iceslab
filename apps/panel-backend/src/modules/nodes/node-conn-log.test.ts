import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { ConnLogClearResponse, ConnLogTraceResponse } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { setBaseLogger } from '../../lib/infra/logger.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeRequestError, NodeTransport } from './nodes.transport.js';

const alerts: string[] = [];
vi.mock('../../lib/notify/telegram-notify.js', async (real) => ({
  ...(await real<typeof import('../../lib/notify/telegram-notify.js')>()),
  notifyTelegramAsync: (text: string) => {
    alerts.push(text);
  },
}));

/**
 * A-265: /api/nodes/:id/conn-log and .../clear, the node's answer passed
 * through, the agent replaced. The clearing is recorded in the panel's log
 * and told on Telegram, with no address in either.
 */

let app: FastifyInstance;
let admin: string;
const lines: string[] = [];

const trace: ConnLogTraceResponse = {
  present: true,
  since: '2026-10-05T09:00:00Z',
  sources: ['journal'],
  checks: [
    { source: 'journal', state: 'found', since: '2026-10-05T09:00:00Z' },
    { source: 'syslog', state: 'absent', since: null },
  ],
};
const cleared: ConnLogClearResponse = {
  results: [
    { source: 'journal', state: 'cleared', steps: [{ command: 'journalctl --rotate', ok: true }, { command: 'journalctl --vacuum-time=1s', ok: true }] },
    { source: 'syslog', state: 'absent', steps: [] },
  ],
  after: { present: false, since: null, sources: [], checks: [
    { source: 'journal', state: 'clean', since: null },
    { source: 'syslog', state: 'absent', since: null },
  ] },
};

beforeEach(async () => {
  lines.length = 0;
  alerts.length = 0;
  app = await buildApp({ log: { level: 'info', stream: { write: (l: string) => void lines.push(l) } } });
  setBaseLogger(app.log);
  await cleanDatabase();
  admin = await registerAndLogin(app);
  // The login's own notice is not this file's business.
  alerts.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function node(): Promise<string> {
  const n = await prisma.node.create({
    data: { name: 'ru-01', address: '198.51.100.20:1337', protocol: 'xray', heartbeatSecret: randomBytes(32) },
    select: { id: true },
  });
  return n.id;
}

const call = (method: 'GET' | 'POST', url: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(method === 'POST' ? { payload: {} } : {}) });

describe('the check', () => {
  it('hands the node answer on as it came', async () => {
    const id = await node();
    vi.spyOn(NodeTransport.prototype, 'getConnLog').mockResolvedValue(trace);
    const res = await call('GET', `/api/nodes/${id}/conn-log`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(trace);
  });

  it('an agent older than the route: 409 UPDATE_AGENT, as with the certificate', async () => {
    const id = await node();
    vi.spyOn(NodeTransport.prototype, 'getConnLog').mockRejectedValue(new NodeRequestError('404', 404, null));
    const res = await call('GET', `/api/nodes/${id}/conn-log`);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'UPDATE_AGENT' });
  });

  it('a node that does not answer: 502 with its words; no such node: 404', async () => {
    const id = await node();
    vi.spyOn(NodeTransport.prototype, 'getConnLog').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await call('GET', `/api/nodes/${id}/conn-log`);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'CONN_LOG_NODE_FAILED', message: expect.stringContaining('ECONNREFUSED') });

    const none = await call('GET', '/api/nodes/7c1e4a52-9b3d-4f8e-a6c2-15d0e9b7f342/conn-log');
    expect(none.statusCode).toBe(404);
    expect(JSON.parse(none.body)).toMatchObject({ error: 'NOT_FOUND' });
  });
});

describe('the clearing', () => {
  it('hands the result on, writes node.connLog.cleared with who and what, and tells Telegram', async () => {
    const id = await node();
    const spy = vi.spyOn(NodeTransport.prototype, 'clearConnLog').mockResolvedValue(cleared);
    const res = await call('POST', `/api/nodes/${id}/conn-log/clear`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(cleared);
    expect(spy).toHaveBeenCalledTimes(1);

    const adminId = (await prisma.adminUser.findFirstOrThrow({ select: { id: true } })).id;
    const event = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'node.connLog.cleared');
    expect(event).toMatchObject({
      adminId,
      nodeId: id,
      nodeName: 'ru-01',
      outcome: [{ source: 'journal', state: 'cleared' }, { source: 'syslog', state: 'absent' }],
      present: false,
    });
    expect(JSON.stringify(event)).not.toContain('198.51.100.20');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('ru-01');
    expect(alerts[0]).toContain('journal: cleared');
  });

  it('an older agent is refused and nothing is recorded', async () => {
    const id = await node();
    vi.spyOn(NodeTransport.prototype, 'clearConnLog').mockRejectedValue(new NodeRequestError('404', 404, null));
    const res = await call('POST', `/api/nodes/${id}/conn-log/clear`);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'UPDATE_AGENT' });
    expect(lines.some((l) => l.includes('node.connLog.cleared'))).toBe(false);
    expect(alerts).toHaveLength(0);
  });
});
