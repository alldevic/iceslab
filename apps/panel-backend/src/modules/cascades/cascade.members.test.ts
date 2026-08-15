import { describe, expect, it } from 'vitest';
import { cascadeMemberNodeIds } from './cascade.service.js';

/**
 * Who counts as part of a cascade, and therefore who gets pushed to.
 *
 * A cascade is stored twice: the legacy `hops` chain and the v4
 * `positions`/`directions` topology. The fold that keeps `hops` in step refuses
 * two v4 shapes it cannot express, and a pool on a position is one of them, so
 * an ordinary cascade can legitimately have ZERO hop rows.
 *
 * Reading membership from hops alone therefore reports "no members" for a
 * working cascade. On 2026-08-15 that meant every save of a cascade with a
 * two-node entry pool emitted its change event with an empty node list: nothing
 * was pushed anywhere, the entry cores kept a config xray had already rejected,
 * and there was no way to deliver a fixed one. The panel meanwhile promised
 * "Saving pushes the config to all 5 nodes again".
 */
describe('cascade membership', () => {
  it('finds the members of a v4-only cascade, which has no hop rows at all', () => {
    const ids = cascadeMemberNodeIds({
      hops: [],
      positions: [{ nodes: [{ nodeId: 'entry-a' }, { nodeId: 'entry-b' }] }],
      directions: [
        { nodes: [{ nodeId: 'exit-nl-1' }, { nodeId: 'exit-nl-2' }] },
        { nodes: [{ nodeId: 'exit-se' }] },
      ],
    });
    // The regression: this used to be [].
    expect(ids.sort()).toEqual(['entry-a', 'entry-b', 'exit-nl-1', 'exit-nl-2', 'exit-se']);
  });

  it('still finds the members of a legacy hop chain', () => {
    expect(
      cascadeMemberNodeIds({ hops: [{ nodeId: 'a' }, { nodeId: 'b' }] }).sort(),
    ).toEqual(['a', 'b']);
  });

  it('counts a node once when both shapes name it', () => {
    // Both storages describe the same cascade, so overlap is the normal case,
    // not an edge one: pushing twice to one node is wasted work and an extra
    // core restart.
    const ids = cascadeMemberNodeIds({
      hops: [{ nodeId: 'entry' }, { nodeId: 'exit' }],
      positions: [{ nodes: [{ nodeId: 'entry' }] }],
      directions: [{ nodes: [{ nodeId: 'exit' }] }],
    });
    expect(ids.sort()).toEqual(['entry', 'exit']);
  });

  it('reports nobody for a cascade that really has nobody', () => {
    expect(cascadeMemberNodeIds({})).toEqual([]);
  });
});
