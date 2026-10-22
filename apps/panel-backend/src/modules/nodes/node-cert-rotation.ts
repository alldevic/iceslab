import { prisma } from '../../prisma.js';
import { bootstrapCa } from '../keygen/keygen.service.js';
import { certFingerprintSha256, certNotAfter, generateNodeCert } from '../keygen/keygen.crypto.js';
import { NodeRequestError, NodeTransport } from './nodes.transport.js';
import { getLogger } from '../../lib/infra/logger.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/notify/telegram-notify.js';

/**
 * A-124: renewing a node's mTLS server certificate over the live channel.
 *
 * The node's pair is issued at bootstrap for a year, and until this nothing
 * renewed it: a year after install the panel would stop reaching the node,
 * and the only way back was a reinstall, which wipes its credentials.
 *
 * One rotation, in order:
 *   1. read the leaf the node serves now from a fresh handshake, for its names:
 *      the agent refuses a new pair that drops a name or address the old one
 *      carries, and the node's address may have changed since its bootstrap;
 *   2. issue a pair under the panel CA for those names plus the current address;
 *   3. POST /rotateCert; the agent serves the pair to new handshakes and waits
 *      for a confirm, rolling back by itself when none comes by `confirmBy`;
 *   4. confirm from a NEW connection, refused at its handshake unless the node
 *      presents exactly the leaf issued here. Not confirmed, the node goes back
 *      to the old pair on its own, so a mistake costs nothing but a retry.
 *
 * The private key lives in this function's scope and in the request body only:
 * it is not logged, not stored, not put into an error.
 */

/** Renew this long before notAfter. */
export const CERT_RENEW_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export class NodeCertRotationError extends Error {
  constructor(
    message: string,
    /** UPDATE_AGENT: the agent has no /rotateCert (404). PENDING: an earlier
     *  rotation still waits for its confirm. INVALID: the agent refused the
     *  pair. UNCONFIRMED: issued and served, but the confirm did not land. */
    public readonly code: 'NODE_NOT_FOUND' | 'UPDATE_AGENT' | 'PENDING' | 'INVALID' | 'UNCONFIRMED' | 'UNREACHABLE',
  ) {
    super(message);
    this.name = 'NodeCertRotationError';
  }
}

export interface RotateNodeCertOptions {
  /** Lifetime of the new pair; a year by default. Tests pass a short one. */
  lifetimeMs?: number;
}

export interface RotatedNodeCert {
  fingerprint: string;
  notAfter: string;
}

/** Names a leaf carries, from Node's `subjectaltname` string. */
export function sansOf(subjectAltName: string): { type: 'dns' | 'ip'; value: string }[] {
  const out: { type: 'dns' | 'ip'; value: string }[] = [];
  for (const part of subjectAltName.split(', ')) {
    if (part.startsWith('DNS:')) out.push({ type: 'dns', value: part.slice(4) });
    else if (part.startsWith('IP Address:')) out.push({ type: 'ip', value: part.slice(11) });
  }
  return out;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export async function rotateNodeCert(nodeId: string, opts: RotateNodeCertOptions = {}): Promise<RotatedNodeCert> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null },
    select: { id: true, name: true, address: true },
  });
  if (!node) throw new NodeCertRotationError(`node ${nodeId} not found`, 'NODE_NOT_FOUND');
  const transport = new NodeTransport(node);

  let presented;
  try {
    presented = await transport.presentedCert();
  } catch (err) {
    throw new NodeCertRotationError(`node ${node.name} is not reachable: ${errorText(err)}`, 'UNREACHABLE');
  }
  const host = node.address.split(':')[0]!;
  const sans = sansOf(presented.subjectAltName);
  if (!sans.some((s) => s.value === host)) sans.push({ type: IPV4_RE.test(host) ? 'ip' : 'dns', value: host });

  const pair = await generateNodeCert(await bootstrapCa(), {
    commonName: node.name,
    sans,
    lifetimeMs: opts.lifetimeMs,
  });
  const fingerprint = await certFingerprintSha256(pair.certPem);

  let rotated;
  try {
    rotated = await transport.rotateCert({ certPem: pair.certPem, keyPem: pair.privateKeyPem });
  } catch (err) {
    if (err instanceof NodeRequestError && err.status === 404) {
      throw new NodeCertRotationError(`node ${node.name}: the agent has no certificate rotation, update it`, 'UPDATE_AGENT');
    }
    if (err instanceof NodeRequestError && err.body?.error === 'CERT_ROTATION_PENDING') {
      throw new NodeCertRotationError(`node ${node.name}: an earlier rotation still waits for its confirm`, 'PENDING');
    }
    if (err instanceof NodeRequestError && err.body?.error === 'CERT_INVALID') {
      throw new NodeCertRotationError(`node ${node.name} refused the new pair: ${err.body.message}`, 'INVALID');
    }
    throw new NodeCertRotationError(`node ${node.name}: rotateCert failed: ${errorText(err)}`, 'UNREACHABLE');
  }
  if (rotated.fingerprint !== fingerprint) {
    // Not ours: leave it unconfirmed, and the agent rolls back by itself.
    throw new NodeCertRotationError(
      `node ${node.name} reports ${rotated.fingerprint} for the pair issued as ${fingerprint}`,
      'UNCONFIRMED',
    );
  }

  try {
    await transport.confirmCertOnFreshConnection(fingerprint);
  } catch (err) {
    throw new NodeCertRotationError(
      `node ${node.name}: the new pair was not confirmed, the agent goes back to the old one by ${rotated.confirmBy}: ${errorText(err)}`,
      'UNCONFIRMED',
    );
  }

  const notAfter = certNotAfter(pair.certPem);
  await prisma.node.update({ where: { id: node.id }, data: { certNotAfter: notAfter } });
  getLogger().info({ node: node.name, fingerprint, notAfter }, '[cert] node certificate renewed');
  return { fingerprint, notAfter: notAfter.toISOString() };
}

/**
 * The cron's part: every live node whose certificate ends within
 * CERT_RENEW_AHEAD_MS. One at a time; a failure is logged and told, and the
 * next tick tries again.
 */
export async function renewExpiringNodeCerts(now = new Date()): Promise<{ renewed: number; failed: number }> {
  const due = await prisma.node.findMany({
    where: {
      deletedAt: null,
      status: { in: ['online', 'degraded'] },
      certNotAfter: { lt: new Date(now.getTime() + CERT_RENEW_AHEAD_MS) },
    },
    select: { id: true, name: true },
  });
  let renewed = 0;
  let failed = 0;
  for (const n of due) {
    try {
      await rotateNodeCert(n.id);
      renewed++;
    } catch (err) {
      failed++;
      getLogger().warn({ node: n.name, err: errorText(err) }, '[cert] node certificate renewal failed');
      notifyTelegramAsync(
        `🔐 *Node certificate not renewed*\nnode: \`${escapeMarkdown(n.name)}\`\n${escapeMarkdown(errorText(err))}`,
      );
    }
  }
  return { renewed, failed };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
