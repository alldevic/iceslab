import { prisma } from '../../prisma.js';
import { canonicalIpv6 } from '@iceslab/shared';
import { bootstrapCa } from '../keygen/keygen.service.js';
import { certFingerprintSha256, certNotAfter, generateNodeCert } from '../keygen/keygen.crypto.js';
import { NodeRequestError, NodeTransport } from './nodes.transport.js';
import { sanOf as nodeSanOf } from './node-payload.js';
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
  /**
   * An address the node does not have yet (19.15): its name goes into the new
   * pair beside the old ones, while the node is still dialled at its stored
   * address. A node moved to an address its certificate does not name cannot be
   * reached at all, so the pair has to be issued before the address is.
   */
  extraAddress?: string;
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

const sameName = (a: string, b: string): boolean => (canonicalIpv6(a) ?? a) === (canonicalIpv6(b) ?? b);

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
    throw new NodeCertRotationError(`node ${node.name} is not reachable: ${reachText(err)}`, 'UNREACHABLE');
  }
  const sans = sansOf(presented.subjectAltName);
  // Node prints an IPv6 SAN expanded and upper-case (`IP Address:2001:DB8:0:0:0:0:0:1`),
  // so the two sides are compared in one spelling, or the name would be added twice.
  for (const want of [nodeSanOf(node.address), ...(opts.extraAddress ? [nodeSanOf(opts.extraAddress)] : [])]) {
    if (!sans.some((s) => sameName(s.value, want.value))) sans.push(want);
  }

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
  await prisma.node.update({ where: { id: node.id }, data: { certNotAfter: notAfter, certFromHandshake: false } });
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
      // A-221: an end read off the handshake is an agent without rotation:
      // asking it would only 404 every hour. The card tells the operator.
      certFromHandshake: false,
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

/**
 * Why a dial failed, in words. undici reports every network failure as
 * "fetch failed" and keeps the reason in `cause`; a refused name check was
 * indistinguishable from a timeout (19.15, the 502 after a node moved to an
 * address its certificate does not name), and the two have different cures.
 */
export function reachText(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  if (cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return (
      `the certificate it serves does not name the address the panel dials (${cause.message ?? 'name mismatch'}); ` +
      'give the node its old address back, or reinstall the agent from the new one'
    );
  }
  if (cause?.code && cause.message) return `${errorText(err)} (${cause.code}: ${cause.message})`.slice(0, 300);
  if (cause?.code) return `${errorText(err)} (${cause.code})`;
  return errorText(err);
}
