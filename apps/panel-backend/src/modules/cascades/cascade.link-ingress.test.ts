import { describe, expect, it } from 'vitest';
import { chainLinkIngressOf } from './cascade.service.js';
import type { LinkCred, TopologyInput } from './cascade.config.js';

/**
 * A-111: the ports a node's chain receives legs on, for its firewall. The agent
 * opened a leg's port only from the legacy xray fragments, which a node with a
 * chain does not get, so a hy2 or tuic leg met a closed port from its first
 * push. The chain block now names them.
 */
const cred = (protocol: LinkCred['protocol'], port: number) => ({ protocol, port }) as unknown as LinkCred;

function topology(links: TopologyInput['links']): TopologyInput {
  return {
    links,
    hosts: new Map([
      ['entry', '1.1.1.1'],
      ['transit', 'transit.example'],
      ['exit', '3.3.3.3'],
      ['other', '4.4.4.4'],
    ]),
  } as unknown as TopologyInput;
}

describe('chainLinkIngressOf', () => {
  it('one entry per port with every hop that dials it, transports by cell', () => {
    const t = topology([
      { fromNodeId: 'entry', toNodeId: 'transit', directionTag: 1, cred: cred('vless', 24000) },
      { fromNodeId: 'other', toNodeId: 'transit', directionTag: 2, cred: cred('vless', 24000) },
      { fromNodeId: 'transit', toNodeId: 'exit', directionTag: 1, cred: cred('hy2', 24001) },
      { fromNodeId: 'entry', toNodeId: 'exit', directionTag: 3, cred: cred('shadowsocks', 24002) },
      { fromNodeId: 'entry', toNodeId: 'exit', directionTag: 4, cred: cred('tuic', 24003) },
    ]);
    expect(chainLinkIngressOf('transit', t)).toEqual([
      { port: 24000, transports: ['tcp'], allowFrom: ['1.1.1.1', '4.4.4.4'] },
    ]);
    expect(chainLinkIngressOf('exit', t)).toEqual([
      { port: 24001, transports: ['udp'], allowFrom: ['transit.example'] },
      { port: 24002, transports: ['tcp', 'udp'], allowFrom: ['1.1.1.1'] },
      { port: 24003, transports: ['udp'], allowFrom: ['1.1.1.1'] },
    ]);
    // The entry receives no leg.
    expect(chainLinkIngressOf('entry', t)).toEqual([]);
  });

  it('leaves out a leg inside an AWG tunnel and a leg whose peer has no address', () => {
    const t = topology([
      { fromNodeId: 'entry', toNodeId: 'exit', directionTag: 1, cred: cred('vless', 24000), underlay: 'awg' },
      { fromNodeId: 'ghost', toNodeId: 'exit', directionTag: 2, cred: cred('vless', 24001) },
    ]);
    expect(chainLinkIngressOf('exit', t)).toEqual([]);
  });
});
