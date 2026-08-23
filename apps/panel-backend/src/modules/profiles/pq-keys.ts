import { prisma } from '../../prisma.js';
import { vlessEncryptionAuth, vlessEncryptionHalf } from '../inbounds/inbounds.schemas.js';
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
  /** mldsa65: the server seed, rendered into the node's REALITY settings. */
  seed?: string;
  /** mldsa65: the verify key clients need. Stored on the profile too, since
   *  U5's client half: without it clients silently verify the classical way. */
  verify?: string;
  /** vlessenc: the server-side decryption string, rendered into the inbound. */
  decryption?: string;
  /** vlessenc: the client-side encryption string, emitted into share links and
   *  full client configs. Stored on the profile alongside its server half. */
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
  // `xray vlessenc` prints FOUR strings, not two: a complete decryption /
  // encryption pair for X25519 authentication and another for ML-KEM-768, under
  // the header "Choose one Authentication to use, do not mix them". Taking the
  // first thing that looks like a server string hands the operator the
  // CLASSICAL pair under a field labelled post-quantum - a profile that works
  // and quietly is not what it says. So the pair is chosen whole, by key
  // length, and the post-quantum one wins.
  //
  // Which half is which comes from the grammar rather than from the labels
  // around it: xray reads a handshake mode (1rtt/0rtt) out of the client half
  // and a ticket lifetime (600s) out of the server half. That is another
  // project's prose against the thing the core actually parses, and the prose
  // has already changed once.
  //
  // The character class matters too: the real output quotes each value
  // (`"decryption": "mlkem768..."`), and a \S+ match swallows the closing quote
  // and produces a string the config schema then refuses.
  const strings = [...raw.matchAll(/mlkem768x25519plus[A-Za-z0-9._-]*/g)].map((m) => m[0]);
  const labelled = (label: RegExp): string | undefined => {
    for (const line of raw.split('\n')) {
      if (!label.test(line)) continue;
      const m = /mlkem768x25519plus[A-Za-z0-9._-]*/.exec(line);
      if (m) return m[0];
    }
    return undefined;
  };
  // Post-quantum first, then classical, then whatever is left for a build whose
  // key sizes we do not recognise - but always both halves from the SAME group,
  // because a server string from one and a client string from the other is a
  // handshake that fails with nothing to read.
  const pickPair = (): { decryption?: string; encryption?: string } => {
    for (const auth of ['mlkem768', 'x25519', 'unknown'] as const) {
      const group = strings.filter((v) => vlessEncryptionAuth(v) === auth);
      const decryption = group.find((v) => vlessEncryptionHalf(v) === 'server');
      const encryption = group.find((v) => vlessEncryptionHalf(v) === 'client');
      if (decryption || encryption) return { decryption, encryption };
    }
    return {};
  };
  const chosen = pickPair();
  // Last resort for output no grammar of ours fits: the labels, and then a lone
  // string, which older builds printed as the server half. Two unrecognised
  // strings stay unplaced - guessing there is how a profile ends up holding the
  // client's string.
  const lone =
    strings.length === 1 && vlessEncryptionHalf(strings[0]) === 'unknown'
      ? strings[0]
      : undefined;
  const decryption = chosen.decryption ?? labelled(/server|decrypt/i) ?? lone;
  const encryption = chosen.encryption ?? labelled(/client|encrypt/i);
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
