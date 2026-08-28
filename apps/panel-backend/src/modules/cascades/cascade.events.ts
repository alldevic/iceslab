import { eventBus } from '../../lib/event-bus.js';
import { getLogger } from '../../lib/logger.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/telegram-notify.js';
import { prisma } from '../../prisma.js';

/**
 * Tell the operator when a cascade has no exit left that can carry traffic.
 *
 * Why this exists: an entry with no reachable exit refuses. A named direction
 * line always did (its rule pins one outbound, and a dead outbound is a failed
 * connection), and since 2026-08-28 the Auto line does too — before that it
 * fell through to the entry's default outbound and quietly egressed from the
 * ENTRY's country, which is the one thing a cascade exists to prevent.
 *
 * Refusing is the right answer, and it is also silent from the panel's side:
 * the subscriber sees a dead tunnel, the operator sees nothing. So the state
 * gets a name and an alert.
 *
 * Edge-triggered off node liveness rather than polled: a cascade can only reach
 * "no live exits" when one of its exits flips, and `node.status-changed` fires
 * exactly then. That also means no extra cross-tick state to keep — and no
 * alert every 30 seconds for as long as the outage lasts.
 *
 * `online` is the bar, not "not unreachable". A `degraded` node answers the
 * agent but its core did not start, and the exit's half of a cascade IS the
 * core: it holds the link-in. Counting degraded as live would report a cascade
 * as fine while every connection through it fails.
 */
let registered = false;

/** Exits of every enabled cascade this node belongs to, with their liveness. */
async function cascadesExitedBy(nodeId: string): Promise<
  { id: string; name: string; live: number; total: number }[]
> {
  const rows = await prisma.cascadeDirection.findMany({
    where: {
      cascade: { enabled: true },
      nodes: { some: { nodeId } },
    },
    select: { cascadeId: true, cascade: { select: { name: true } } },
  });
  const out: { id: string; name: string; live: number; total: number }[] = [];
  for (const cascadeId of new Set(rows.map((r) => r.cascadeId))) {
    const name = rows.find((r) => r.cascadeId === cascadeId)!.cascade.name;
    const members = await prisma.cascadeDirectionNode.findMany({
      where: { direction: { cascadeId } },
      select: { node: { select: { status: true, deletedAt: true } } },
    });
    const usable = members.filter((m) => m.node.deletedAt === null);
    out.push({
      id: cascadeId,
      name,
      live: usable.filter((m) => m.node.status === 'online').length,
      total: usable.length,
    });
  }
  return out;
}

export function registerCascadeEventHandlers(): void {
  if (registered) return;
  registered = true;
  eventBus.on('node.status-changed', async ({ nodeId, to }) => {
    let affected: Awaited<ReturnType<typeof cascadesExitedBy>>;
    try {
      affected = await cascadesExitedBy(nodeId);
    } catch (err) {
      // A liveness flip must not be lost because this lookup failed; the poller
      // has its own work to finish and other handlers to run.
      getLogger().error({ err }, '[event] cascade exit-liveness lookup failed');
      return;
    }
    for (const c of affected) {
      // Only the two edges are worth a word. Everything between them is the
      // same state the operator was already told about.
      const wentDark = c.live === 0;
      const cameBack = c.live === 1 && to === 'online';
      if (!wentDark && !cameBack) continue;
      eventBus.emit('cascade.exits-changed', {
        cascadeId: c.id,
        cascadeName: c.name,
        live: c.live,
        total: c.total,
      });
      if (wentDark) {
        getLogger().warn(
          `[cascade] "${c.name}" has no reachable exit (0/${c.total}); its entry now refuses`,
        );
        notifyTelegramAsync(
          `🔴 *Cascade has no exit*\ncascade: \`${escapeMarkdown(c.name)}\`\n` +
            `exits up: 0 of ${c.total}\n` +
            `the entry refuses traffic rather than egressing from its own country`,
        );
      } else {
        getLogger().info(`[cascade] "${c.name}" has an exit again (1/${c.total})`);
        notifyTelegramAsync(
          `✅ *Cascade has an exit again*\ncascade: \`${escapeMarkdown(c.name)}\`\n` +
            `exits up: 1 of ${c.total}`,
        );
      }
    }
  });
}
