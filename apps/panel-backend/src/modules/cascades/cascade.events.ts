import { eventBus } from '../../lib/infra/event-bus.js';
import { getLogger } from '../../lib/infra/logger.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/notify/telegram-notify.js';
import { prisma } from '../../prisma.js';
import { deadCascadeIds } from './cascade-exclusive.js';

/**
 * Tell the operator when a cascade has no live exit left, and when it has one
 * again.
 *
 * With no live exit the entry refuses subscribers' connections; from the
 * panel's side that is silent: the subscriber sees a dead tunnel, the operator
 * sees nothing. So the state gets a log line, a Telegram message and the
 * `cascade.exits-changed` event (forwarded to webhooks).
 *
 * Edge-triggered off node liveness rather than polled: a cascade reaches "no
 * live exit" only when one of its exits flips, and `node.status-changed` fires
 * exactly then (the poller writes the new status before it emits, so the query
 * below sees it). No state is kept between ticks, and there is no message every
 * 30 seconds for as long as the outage lasts; the price is that a panel restart
 * does not re-announce a cascade that is already dark.
 *
 * `online` is the bar, not "not unreachable": a `degraded` node answers the
 * agent but its core did not start, and the exit's core holds the link-in.
 *
 * Exits are the nodes of the directions. A direction on a named outbound has
 * no node and no status, so it is not counted; a cascade made only of those
 * never reaches this handler. A cascade the panel already treats as dead
 * (deadCascadeIds) is not served to anyone and is not reported.
 */
let registered = false;

interface ExitsOfCascade {
  id: string;
  name: string;
  live: number;
  total: number;
}

/** Enabled cascades this node is an exit of, with live / total exit counts. */
async function cascadesExitedBy(nodeId: string): Promise<ExitsOfCascade[]> {
  const rows = await prisma.cascadeDirection.findMany({
    where: { cascade: { enabled: true }, nodes: { some: { nodeId } } },
    select: { cascadeId: true, cascade: { select: { name: true } } },
  });
  if (rows.length === 0) return [];
  const dead = await deadCascadeIds();
  const out: ExitsOfCascade[] = [];
  for (const cascadeId of new Set(rows.map((r) => r.cascadeId))) {
    if (dead.has(cascadeId)) continue;
    const members = await prisma.cascadeDirectionNode.findMany({
      where: { direction: { cascadeId } },
      select: { nodeId: true, node: { select: { status: true, deletedAt: true } } },
    });
    // A node can sit in several directions of one cascade; it is one exit.
    const usable = new Map(members.filter((m) => m.node.deletedAt === null).map((m) => [m.nodeId, m.node.status]));
    out.push({
      id: cascadeId,
      name: rows.find((r) => r.cascadeId === cascadeId)!.cascade.name,
      live: [...usable.values()].filter((s) => s === 'online').length,
      total: usable.size,
    });
  }
  return out;
}

export function registerCascadeEventHandlers(): void {
  if (registered) return;
  registered = true;
  eventBus.on('node.status-changed', async ({ nodeId, from, to }) => {
    let affected: ExitsOfCascade[];
    try {
      affected = await cascadesExitedBy(nodeId);
    } catch (err) {
      // The other handlers of this event have their own work to do.
      getLogger().error({ err }, '[event] cascade exit-liveness lookup failed');
      return;
    }
    for (const c of affected) {
      // Only the two edges are worth a word; the rest is a state the operator
      // was already told about. "Went dark" needs this node to have been live:
      // unreachable -> degraded in an already dark cascade is no new news.
      const wentDark = c.live === 0 && from === 'online';
      const cameBack = c.live === 1 && to === 'online';
      if (!wentDark && !cameBack) continue;
      eventBus.emit('cascade.exits-changed', {
        cascadeId: c.id,
        cascadeName: c.name,
        live: c.live,
        total: c.total,
      });
      if (wentDark) {
        getLogger().warn(`[cascade] "${c.name}" has no live exit (0/${c.total})`);
        notifyTelegramAsync(
          `🔴 *Cascade has no live exit*\ncascade: \`${escapeMarkdown(c.name)}\`\n` +
            `exits up: 0 of ${c.total}`,
        );
      } else {
        getLogger().info(`[cascade] "${c.name}" has a live exit again (1/${c.total})`);
        notifyTelegramAsync(
          `✅ *Cascade has a live exit again*\ncascade: \`${escapeMarkdown(c.name)}\`\n` +
            `exits up: 1 of ${c.total}`,
        );
      }
    }
  });
}
