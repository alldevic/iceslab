import { describe, expect, it } from 'vitest';
import { toWireFragments } from './cascade.service.js';
import type { HopConfig } from './cascade.config.js';

/**
 * A balancer and its observatory travel together, or the node gets neither.
 *
 * xray's `leastPing` strategy needs somebody to measure the pings. Handed a
 * balancer with no `observatory`, it does not degrade or warn: it refuses the
 * WHOLE config with "not all dependencies are resolved", so the core never
 * starts and the node serves nothing at all, cascade or otherwise.
 *
 * That happened on 2026-08-15. The builder was right and its config-validity
 * test (which runs generated fragments through a real `xray -test`) passed,
 * because the field was not lost in the builder. It was lost in the three
 * hand-copied return blocks that turn a built hop config into the wire shape:
 * two carried `observatory`, the v4 one did not. The entry of a live cascade
 * stayed down for hours, and the panel showed the node green the whole time,
 * because a node's status means "the agent answers", not "the core runs".
 *
 * So this file tests the mapper, not the builder: the seam where it actually
 * broke.
 */

function hop(over: Partial<HopConfig> = {}): HopConfig {
  return {
    nodeId: 'node-1',
    position: 0,
    role: 'entry',
    inbounds: [{ tag: 'cascade-link-in', port: 24000 }],
    outbounds: [
      { tag: 'cascade-link-out-0' },
      // The node ships its own `direct`; two outbounds with one tag are another
      // config xray rejects outright, so the mapper drops ours.
      { tag: 'direct' },
    ],
    routingRules: [{ type: 'field', outboundTag: 'cascade-link-out-0' }],
    ...over,
  } as HopConfig;
}

describe('cascade fragments on the wire', () => {
  it('keeps the observatory next to the balancers', () => {
    const wire = toWireFragments(
      hop({
        balancers: [
          { tag: 'bal-d1', selector: ['cascade-link-out'], strategy: { type: 'leastPing' } },
        ],
        observatory: { subjectSelector: ['cascade-link-out'], probeURL: 'https://www.gstatic.com/generate_204' },
      }),
    );

    // The regression: this used to come back with balancers and no observatory,
    // which xray reads as a config it cannot resolve.
    expect(wire.balancers).toHaveLength(1);
    expect(wire.observatory).toBeDefined();
  });

  it('never ships balancers without an observatory', () => {
    // Guard on the invariant rather than on one call site: any future path that
    // builds fragments has to satisfy it too.
    const wire = toWireFragments(
      hop({
        balancers: [{ tag: 'bal-d1', selector: ['x'], strategy: { type: 'leastPing' } }],
        observatory: { subjectSelector: ['x'] },
      }),
    );
    if (wire.balancers && wire.balancers.length > 0) {
      expect(
        wire.observatory,
        'a leastPing balancer with no observatory makes xray reject the entire config',
      ).toBeDefined();
    }
  });

  it('carries the link port and peer so the agent can open its own firewall', () => {
    const wire = toWireFragments(
      hop({ linkIngressPort: 24000, linkAllowFrom: ['203.0.113.7'] }),
    );
    expect(wire.linkIngressPort).toBe(24000);
    expect(wire.linkAllowFrom).toEqual(['203.0.113.7']);
  });

  it('drops our direct outbound, which the node already has', () => {
    const wire = toWireFragments(hop());
    expect(wire.outbounds.map((o) => (o as { tag: string }).tag)).not.toContain('direct');
    expect(wire.outbounds).toHaveLength(1);
  });

  it('leaves a plain chain hop without balancer machinery', () => {
    const wire = toWireFragments(hop({ role: 'transit' }));
    expect(wire.balancers).toBeUndefined();
    expect(wire.observatory).toBeUndefined();
  });
});
