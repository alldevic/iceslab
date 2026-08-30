import { describe, expect, it } from 'vitest';
import {
  assertPortHoppingFitsNodes,
  PortHoppingOutsideNodeRangeError,
} from './profiles.service.js';

/**
 * A hysteria profile tells clients which ports to rotate across; the NODE
 * decides which ports it redirects to its listener, at install time
 * (`--hysteria-port-range`, default 20000-50000). Until the node started
 * reporting that range, the panel accepted any range at all - and the cost of
 * the mismatch is invisible from both ends. The client honestly rotates its
 * destination port, the ports outside the node's range reach nothing, and
 * neither the panel nor the node logs a thing. Connections just fail, some of
 * them, sometimes.
 *
 * This is the half no schema can do: whether a range is deliverable is a fact
 * about the machines a profile is BOUND to, and two nodes can redirect two
 * different ranges. hysteria-port-hopping.test.ts holds the schema's half
 * (shape and pairing) and asserts it stayed out of this one.
 *
 * The rule that matters most here is what happens with NO answer. A node that
 * reports nothing - no rule, no iptables, an agent older than the field - must
 * not be judged: refusing a save against a number the panel does not have is
 * the same failure as accepting one blindly, pointed the other way.
 */

const node = (name: string, start: number | null, end: number | null) => ({
  name,
  portHoppingStart: start,
  portHoppingEnd: end,
});

const range = (start: number, end: number) => ({
  portHoppingStart: start,
  portHoppingEnd: end,
});

const check = (config: unknown, nodes: ReturnType<typeof node>[]) =>
  assertPortHoppingFitsNodes('hysteria', 'hy-1', config, nodes);

describe('a port-hopping range against what the nodes redirect', () => {
  it('accepts a range inside the node range', () => {
    expect(() => check(range(30000, 40000), [node('n1', 20000, 50000)])).not.toThrow();
  });

  it('accepts a range exactly equal to it', () => {
    expect(() => check(range(20000, 50000), [node('n1', 20000, 50000)])).not.toThrow();
  });

  it('refuses a range wider than the node redirects, and names the node', () => {
    expect(() => check(range(1100, 1200), [node('ru-01', 20000, 50000)])).toThrow(
      PortHoppingOutsideNodeRangeError,
    );
    try {
      check(range(1100, 1200), [node('ru-01', 20000, 50000)]);
    } catch (err) {
      const e = err as PortHoppingOutsideNodeRangeError;
      expect(e.nodeName).toBe('ru-01');
      // The message has to carry both halves and the way out: an operator
      // reading it should not have to go find which node, or what it redirects,
      // or how to change it.
      expect(e.message).toContain('ru-01');
      expect(e.message).toContain('1100-1200');
      expect(e.message).toContain('20000-50000');
      expect(e.message).toContain('--hysteria-port-range');
    }
  });

  it('refuses a range that only PARTLY overlaps, at either end', () => {
    // The quiet shape: most of the rotation lands, some of it does not, so the
    // profile looks like it works and drops a fraction of connections.
    expect(() => check(range(19000, 30000), [node('n1', 20000, 50000)])).toThrow();
    expect(() => check(range(40000, 60000), [node('n1', 20000, 50000)])).toThrow();
  });

  it('names the FIRST node that would not deliver it, out of several', () => {
    expect(() =>
      check(range(20000, 50000), [
        node('wide', 20000, 50000),
        node('narrow', 30000, 40000),
      ]),
    ).toThrow(/narrow/);
  });

  // Absent is not "false". Three states arrive as null, and none of them is a
  // number to refuse a save against.
  it('does not judge a node that has reported no range', () => {
    expect(() => check(range(1100, 1200), [node('quiet', null, null)])).not.toThrow();
    expect(() => check(range(1100, 1200), [node('half', 20000, null)])).not.toThrow();
    expect(() => check(range(1100, 1200), [])).not.toThrow();
  });

  it('says nothing when port-hopping is off', () => {
    expect(() => check({}, [node('n1', 20000, 50000)])).not.toThrow();
    expect(() => check({ obfsPassword: 'x' }, [node('n1', 20000, 50000)])).not.toThrow();
  });

  // Half a pair and an inverted range are the schema's to refuse, and it does,
  // with a message about the field. Refusing them a second time here would
  // report them as a node problem, which they are not.
  it('leaves half a pair and an inverted range to the schema', () => {
    expect(() =>
      check({ portHoppingStart: 30000 }, [node('n1', 20000, 50000)]),
    ).not.toThrow();
    expect(() => check(range(50000, 20000), [node('n1', 20000, 50000)])).not.toThrow();
  });

  it('judges hysteria only', () => {
    // Every other protocol carries no such range; reading these keys off an
    // xray config would refuse a profile over a field that means nothing to it.
    expect(() =>
      assertPortHoppingFitsNodes('xray', 'x-1', range(1100, 1200), [
        node('n1', 20000, 50000),
      ]),
    ).not.toThrow();
  });
});
