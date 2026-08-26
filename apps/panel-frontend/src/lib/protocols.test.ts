// The version gate in front of cascade exit selection.
//
// Below xray 25.9.5 the balancer entry rejects the client at authentication and
// the connection just fails, so the panel warns before the save and the backend
// refuses to enable such a cascade. A comparison that answers wrongly here is
// this project's classic failure: the operator saves, the panel is content, and
// the tunnel is dead for a reason nothing on screen mentions.

import { describe, expect, it } from 'vitest';
import { MIN_CASCADE_CORE, isOlderThan, protocolLabel, protocolLabelCompact } from './protocols';

describe('isOlderThan', () => {
  it('compares the segments as numbers, not as text', () => {
    // The one that a string comparison gets backwards: "25.10.0" sorts before
    // "25.9.5" as text, and a node on a NEWER core would be told to upgrade.
    expect(isOlderThan('25.10.0', '25.9.5')).toBe(false);
    expect(isOlderThan('25.9.10', '25.9.5')).toBe(false);
    expect(isOlderThan('25.9.5', '25.10.0')).toBe(true);
  });

  it('answers the plain cases', () => {
    expect(isOlderThan('25.9.4', MIN_CASCADE_CORE)).toBe(true);
    expect(isOlderThan('25.9.5', MIN_CASCADE_CORE), 'the minimum itself is not older').toBe(false);
    expect(isOlderThan('26.3.27', MIN_CASCADE_CORE)).toBe(false);
    expect(isOlderThan('24.12.31', MIN_CASCADE_CORE)).toBe(true);
  });

  // What the cores actually print: `xray version` and friends prefix a v, and
  // pre-releases carry a suffix.
  it('reads the shapes a core binary actually reports', () => {
    expect(isOlderThan('v25.9.4', MIN_CASCADE_CORE)).toBe(true);
    expect(isOlderThan('V26.0.0', MIN_CASCADE_CORE)).toBe(false);
    expect(isOlderThan('25.9.5-beta1', MIN_CASCADE_CORE), 'the suffix is not part of the number').toBe(false);
    expect(isOlderThan('25.9.4+build7', MIN_CASCADE_CORE)).toBe(true);
  });

  it('treats a missing segment as zero', () => {
    expect(isOlderThan('25.9', '25.9.5')).toBe(true);
    expect(isOlderThan('26', '25.9.5')).toBe(false);
    expect(isOlderThan('25.9.5', '25.9')).toBe(false);
  });

  // A node that has not reported a version yet is unknown, not old. Warning
  // there would cry wolf on every freshly added node.
  //
  // Measured: the explicit `if (Number.isNaN(x)) return false` inside the loop
  // is unreachable in effect - `x < y` is already false for NaN, so deleting it
  // changes no answer. The null/empty guard at the top is the one doing the
  // work, and it reddens.
  it('does not call an unknown version old', () => {
    expect(isOlderThan(null, MIN_CASCADE_CORE)).toBe(false);
    expect(isOlderThan(undefined, MIN_CASCADE_CORE)).toBe(false);
    expect(isOlderThan('', MIN_CASCADE_CORE)).toBe(false);
    expect(isOlderThan('unknown', MIN_CASCADE_CORE)).toBe(false);
    expect(isOlderThan('xray 25.9.4 (unreadable)', MIN_CASCADE_CORE)).toBe(false);
  });

  it('pins the minimum the rest of the panel is written against', () => {
    expect(MIN_CASCADE_CORE).toBe('25.9.5');
  });
});

describe('protocol labels', () => {
  it('names a protocol the operator would recognise', () => {
    expect(protocolLabel('amneziawg')).not.toBe('');
    expect(protocolLabelCompact('amneziawg').length).toBeLessThanOrEqual(
      protocolLabel('amneziawg').length,
    );
  });

  // An unknown protocol must show its own name rather than an empty cell: a
  // protocol added on the backend appears in the UI before the label does.
  it('falls back to the raw value it was given', () => {
    expect(protocolLabel('brand-new-protocol')).toBe('brand-new-protocol');
    expect(protocolLabelCompact('brand-new-protocol')).toBe('brand-new-protocol');
  });
});
