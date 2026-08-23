import type { ApplyEgressRequest } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/logger.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { Zapret2ConfigSchema, resolveZapret2Config } from './egress.zapret2.js';

/** Minimal node shape NodeTransport needs (panel-side mTLS keys on address). */
interface EgressNode {
  id: string;
  name: string;
  address: string;
}

/**
 * B2a - push the node's zapret2 channel config (stored under
 * Node.hardening.zapret2) to the agent. Best-effort: a node with no egress
 * policy is skipped entirely (no /applyEgress call), and a push failure is
 * logged but NOT re-thrown: the channel is independent of the inbound sync that
 * calls this, so a zapret2 hiccup must not block protocol-server updates.
 *
 * A node sends an /applyEgress with enabled=false to tear egress down when an
 * admin disables a previously-enabled policy (the blob still carries
 * {enabled:false}); a node that NEVER had a policy is never contacted, so its
 * behaviour stays byte-identical to pre-B2.
 */
export async function applyEgressForNode(node: EgressNode): Promise<void> {
  const row = await prisma.node.findUnique({
    where: { id: node.id },
    select: { hardening: true },
  });
  const hardening = row?.hardening as { zapret2?: unknown } | null | undefined;
  if (hardening?.zapret2 == null) {
    return; // this node does not run the zapret2 channel, nothing to push.
  }

  // The blob is admin-supplied JSON persisted earlier; re-validate before use.
  const parsed = Zapret2ConfigSchema.safeParse(hardening.zapret2);
  if (!parsed.success) {
    getLogger().warn(
      `[egress] node ${node.name}: stored zapret2 config is invalid, skipping push: ${parsed.error.message}`,
    );
    return;
  }

  let req: ApplyEgressRequest;
  try {
    req = resolveZapret2Config(parsed.data);
  } catch (err) {
    getLogger().warn(
      `[egress] node ${node.name}: cannot resolve egress config, skipping push: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const transport = new NodeTransport(node);
  try {
    const res = await transport.applyEgress(req);
    getLogger().info(
      `[egress] node ${node.name}: applyEgress ok, enabled=${req.enabled} applied=${res.applied}`,
    );
  } catch (err) {
    if (err instanceof NodeRequestError && err.status === 404) {
      getLogger().info(
        `[egress] node ${node.name}: agent has no /applyEgress (pre-B2a), channel not applied`,
      );
      return;
    }
    getLogger().warn(
      `[egress] node ${node.name}: applyEgress FAILED (non-fatal): ${
        err instanceof NodeRequestError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      }`,
    );
  }
}
