import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/logger.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';

/**
 * U5 - generate post-quantum key material for an xray profile.
 *
 * The material can only come from the xray binary (`xray mldsa65`,
 * `xray vlessenc`), and the panel has no such binary: it is a Node process, and
 * bundling xray into its image would mean the panel mints keys with one build
 * while the nodes that use them run another. So the panel asks a NODE, over the
 * mTLS channel it already has, and the keys come from the very core that will
 * use them.
 *
 * Which node: whichever answers. A node can be offline, run an agent that
 * predates the endpoint, or run an xray too old to know the subcommand, and
 * none of those is worth making the operator diagnose - the panel tries the
 * likeliest few and reports what each said if they all fail.
 */

export const PQ_KEY_KINDS = ['mldsa65', 'vlessenc'] as const;
export type PqKeyKind = (typeof PQ_KEY_KINDS)[number];

export class NoKeygenNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoKeygenNodeError';
  }
}

export interface PqKeys {
  kind: PqKeyKind;
  /** The node that produced them, so the operator knows which build these came from. */
  nodeName: string;
  /** The subcommand's output, always returned: when a field below is missing
   *  this is the only way the operator can still get their key. */
  raw: string;
  /** mldsa65: the server seed, which is what the profile stores. */
  seed?: string;
  /** mldsa65: the verify key clients need. */
  verify?: string;
  /** vlessenc: the server-side decryption string, which the profile stores. */
  decryption?: string;
  /** vlessenc: the client-side encryption string, for the share link. */
  encryption?: string;
}

/**
 * Pull the fields out of a keygen subcommand's output.
 *
 * Deliberately loose. The exact wording of these outputs has changed between
 * xray releases and will again, and a parser that only accepts today's phrasing
 * would turn a working node into a broken button. Anything it cannot place
 * stays in `raw` for the operator to copy, which is strictly what they have
 * today.
 */
export function parsePqKeyOutput(kind: PqKeyKind, raw: string): Omit<PqKeys, 'kind' | 'nodeName'> {
  if (kind === 'mldsa65') {
    return {
      raw,
      ...pick(raw, /seed[^:\n]*:\s*(\S+)/i, 'seed'),
      ...pick(raw, /verify[^:\n]*:\s*(\S+)/i, 'verify'),
    };
  }
  // vlessenc prints both halves of the pair, and which is which is what matters:
  // the server half goes in the profile and the client half in the share link,
  // and swapping them yields a profile nobody can connect to. Match on the label
  // rather than on order.
  const strings = [...raw.matchAll(/mlkem768x25519plus\.\S+/g)].map((m) => m[0]);
  const labelled = (label: RegExp): string | undefined => {
    for (const line of raw.split('\n')) {
      if (!label.test(line)) continue;
      const m = /mlkem768x25519plus\.\S+/.exec(line);
      if (m) return m[0];
    }
    return undefined;
  };
  // With no labels to go on, a single string is unambiguous (older builds
  // printed only the server half); two unlabelled ones are not, and guessing is
  // how a profile ends up holding the client's string.
  const decryption = labelled(/server|decrypt/i) ?? (strings.length === 1 ? strings[0] : undefined);
  const encryption = labelled(/client|encrypt/i);
  return {
    raw,
    ...(decryption ? { decryption } : {}),
    ...(encryption ? { encryption } : {}),
  };
}

function pick(raw: string, re: RegExp, key: 'seed' | 'verify'): Record<string, string> {
  const m = re.exec(raw);
  return m ? { [key]: m[1] } : {};
}

/** How many nodes to try before giving up. Past a few, the answer is not "try
 *  harder" but "no node here can do this", and each attempt is a round trip. */
const MAX_ATTEMPTS = 3;

export async function generatePqKeys(kind: PqKeyKind, nodeId?: string): Promise<PqKeys> {
  const candidates = await prisma.node.findMany({
    where: {
      deletedAt: null,
      ...(nodeId ? { id: nodeId } : { status: 'online' }),
    },
    select: { id: true, name: true, address: true, coreVersion: true },
    // A node that has reported a core version has answered a healthcheck as a
    // core we know; it is the likeliest to have the binary.
    orderBy: [{ coreVersion: 'desc' }, { name: 'asc' }],
    take: nodeId ? 1 : MAX_ATTEMPTS,
  });
  if (candidates.length === 0) {
    throw new NoKeygenNodeError(
      nodeId ? 'node not found' : 'no online node to generate keys on',
    );
  }

  const failures: string[] = [];
  for (const node of candidates) {
    try {
      const res = await new NodeTransport(node).generateKeys({ kind });
      return { kind, nodeName: node.name, ...parsePqKeyOutput(kind, res.raw) };
    } catch (err) {
      const reason =
        err instanceof NodeRequestError && err.status === 404
          ? 'agent predates /generateKeys'
          : err instanceof Error
            ? err.message
            : String(err);
      failures.push(`${node.name}: ${reason}`);
      getLogger().info(`[pq-keygen] ${node.name} could not generate ${kind}: ${reason}`);
    }
  }
  throw new NoKeygenNodeError(`no node could generate ${kind} keys (${failures.join('; ')})`);
}
