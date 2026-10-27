import { eventBus } from '../../lib/infra/event-bus.js';
import { escapeMarkdown, notifyTelegramAsync } from '../../lib/notify/telegram-notify.js';
import { prisma } from '../../prisma.js';
import { formatBytes } from '../settings/settings.service.js';
import { nodeUsersQueue } from '../users/users.queue.js';

/**
 * Register node-related event handlers. Mirrors users/users.events.ts.
 *
 * `node.created` → enqueue a backfillNode job so existing active users land
 * on the freshly-registered node. Without this, a new node stays empty until
 * each user is mutated again, caught live during the 2026-05-06 VPS test
 * (Hysteria auth rejected pre-existing user because adapter map was empty on
 * the new node).
 *
 * `node.anomaly` / `node.anomaly-cleared` → the admin chat. The status alert
 * (nodes.cron) never fires for this: the agent still answers, the node stays
 * online, and only its users notice. The webhook bus forwards both as well
 * (webhook.events.ts).
 */
export function registerNodeEventHandlers(): void {
  eventBus.on('node.created', async ({ nodeId, nodeName }) => {
    console.log(`[event] node.created: ${nodeName} (${nodeId})`);
    await nodeUsersQueue.add('backfillNode', { nodeId });
  });

  eventBus.on('node.anomaly', async (ev) => {
    const node = await prisma.node.findUnique({ where: { id: ev.nodeId }, select: { name: true } });
    notifyTelegramAsync(
      `📉 *Node stopped carrying traffic* (${ev.severity})\nname: \`${escapeMarkdown(node?.name ?? ev.nodeId)}\`\n` +
        `bytes: ${formatBytes(BigInt(ev.bytesThisPoll))} in the last poll, ${formatBytes(BigInt(ev.expectedBaseline))} usual\n` +
        `users: ${ev.droppedUsers} gone, ${ev.activeUsers} still moving traffic`,
    );
  });

  eventBus.on('node.anomaly-cleared', async ({ nodeId }) => {
    const node = await prisma.node.findUnique({ where: { id: nodeId }, select: { name: true } });
    notifyTelegramAsync(`📈 *Node carries traffic again*\nname: \`${escapeMarkdown(node?.name ?? nodeId)}\``);
  });
}

