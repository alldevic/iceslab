import { isIP } from 'node:net';
import { readIpv6Mode, type NodeCores } from '@iceslab/shared';
import { nodeExitsViaIpv6 } from '../nodes/node-core-gate.js';

/**
 * What a cascade draws from a node's IPv6 facts (milestone 18.8). Unknown is
 * "no": a node never polled, or on an agent older than the facts, has none of
 * this, and every drawing below stays what it was.
 */
export interface NodeIpv6Fact {
  /** The agent has a socket on `::` that takes IPv4 as well. */
  stack: boolean;
  /** Its global IPv6 addresses, sorted. */
  addresses: string[];
  /** Its cores leave by IPv6 (nodeExitsViaIpv6, the node's mode applied). */
  exits: boolean;
}

/** The fact of a node row: its report and its IPv6 mode. */
export function nodeIpv6FactOf(
  cores: NodeCores | null | undefined,
  ipv6Mode: unknown,
): NodeIpv6Fact | undefined {
  const mode = readIpv6Mode(ipv6Mode);
  const exits = nodeExitsViaIpv6(cores, mode);
  const stack = cores?.ipv6?.stack === true;
  const addresses = cores?.ipv6 && Array.isArray(cores.ipv6.addresses)
    ? [...new Set(cores.ipv6.addresses.filter((a) => typeof a === 'string' && isIP(a) === 6))].sort()
    : [];
  if (!stack && !exits && addresses.length === 0) return undefined;
  return { stack, addresses, exits };
}

/** Where a link listener binds: `::` (both families) on a node that reports the
 *  stack, `0.0.0.0` otherwise, as every listener was. */
export function linkListenOf(f: NodeIpv6Fact | undefined): '::' | '0.0.0.0' {
  return f?.stack ? '::' : '0.0.0.0';
}

/**
 * The sources the next hop's firewall lets a leg in from: the address the
 * panel has for the previous hop, as written, and its global IPv6 addresses.
 * The kernel picks the source of a connection, and with the next hop dialled
 * by an IPv6 literal that is one of these and not the recorded IPv4 address or
 * name (A-111). An IPv4 address the host holds is not reported, so the mirror
 * case (recorded by IPv6, dialled by an IPv4 literal) stays a known limit.
 */
export function linkSourcesOf(host: string, f: NodeIpv6Fact | undefined): string[] {
  return [...new Set([host, ...(f?.addresses ?? [])])];
}
