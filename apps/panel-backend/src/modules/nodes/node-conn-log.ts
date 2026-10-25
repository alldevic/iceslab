import type { ConnLogClearResponse, ConnLogTraceResponse } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { NodeRequestError, NodeTransport } from './nodes.transport.js';
import { getLogger } from '../../lib/infra/logger.js';
import { escapeMarkdown, notifyTelegramAsync, redactUsername } from '../../lib/notify/telegram-notify.js';

/**
 * A-265, owner's decision 26.10: the connection lines an older agent left in
 * a node's journal and syslog (one per client, with the address), found and
 * cleared on the operator's request. The node does the work; the panel asks
 * it, and keeps a record of who cleared which node with what result: a line
 * in its own log and a Telegram notice, the way other node events are told.
 * An audit table is later work.
 */

export class NodeConnLogError extends Error {
  constructor(
    message: string,
    /** UPDATE_AGENT: the agent has no /connLog (404), as with the certificate. */
    public readonly code: 'NODE_NOT_FOUND' | 'UPDATE_AGENT' | 'NODE_FAILED',
  ) {
    super(message);
    this.name = 'NodeConnLogError';
  }
}

async function nodeOf(nodeId: string): Promise<{ id: string; name: string; address: string }> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null },
    select: { id: true, name: true, address: true },
  });
  if (!node) throw new NodeConnLogError(`node ${nodeId} not found`, 'NODE_NOT_FOUND');
  return node;
}

function refusal(node: { name: string }, err: unknown): NodeConnLogError {
  if (err instanceof NodeRequestError && err.status === 404) {
    return new NodeConnLogError(`node ${node.name}: the agent does not read the host's logs, update it`, 'UPDATE_AGENT');
  }
  const text = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  return new NodeConnLogError(`node ${node.name}: ${text}`, 'NODE_FAILED');
}

export async function readNodeConnLog(nodeId: string): Promise<ConnLogTraceResponse> {
  const node = await nodeOf(nodeId);
  try {
    return await new NodeTransport({ address: node.address }).getConnLog();
  } catch (err) {
    throw refusal(node, err);
  }
}

export async function clearNodeConnLog(nodeId: string, adminId: string | null): Promise<ConnLogClearResponse> {
  const node = await nodeOf(nodeId);
  let res: ConnLogClearResponse;
  try {
    res = await new NodeTransport({ address: node.address }).clearConnLog();
  } catch (err) {
    throw refusal(node, err);
  }
  const outcome = res.results.map((r) => ({ source: r.source, state: r.state }));
  // No address and no token here (A-267): who, which node, what came of it.
  getLogger().info(
    { event: 'node.connLog.cleared', adminId, nodeId: node.id, nodeName: node.name, outcome, present: res.after.present },
    '[connLog] node connection log cleared',
  );
  const admin = adminId
    ? await prisma.adminUser.findUnique({ where: { id: adminId }, select: { username: true } })
    : null;
  notifyTelegramAsync(
    `🧹 *Connection log cleared*\nnode: \`${escapeMarkdown(node.name)}\`\nby: \`${escapeMarkdown(admin ? redactUsername(admin.username) : 'api token')}\`\n${outcome
      .map((o) => `${o.source}: ${o.state}`)
      .join('\n')}`,
  );
  return res;
}
