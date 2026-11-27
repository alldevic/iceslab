import { describe, expect, it } from 'vitest';
import { CreateNodeSchema, UpdateNodeSchema } from './nodes.schemas.js';
import { agentHostPort } from './nodes.transport.js';

const create = (address: string) => CreateNodeSchema.safeParse({ name: 'n1', address, protocol: 'xray' });

describe('the node address schema', () => {
  it('takes the three IPv6 forms and stores them as one string', () => {
    for (const typed of ['2001:db8::1', '[2001:db8::1]', '[2001:db8::1]:1337', '2001:DB8:0:0:0:0:0:1']) {
      const r = create(typed);
      expect(r.success, typed).toBe(true);
      expect(r.data?.address, typed).toBe('2001:db8::1');
    }
  });

  it('keeps a non-default port, bracketed', () => {
    expect(create('2001:db8::1').data?.address).toBe('2001:db8::1');
    expect(create('[2001:db8::1]:2000').data?.address).toBe('[2001:db8::1]:2000');
    // And the stored form reads back to the same endpoint.
    expect(agentHostPort(create('[2001:db8::1]:2000').data!.address)).toBe('[2001:db8::1]:2000');
  });

  it('leaves a name and an IPv4 exactly as typed', () => {
    for (const typed of ['node1.example.com', 'Node1.Example.com:1337', '203.0.113.7', '203.0.113.7:2000']) {
      expect(create(typed).data?.address, typed).toBe(typed);
    }
  });

  it('refuses what is not an address', () => {
    for (const bad of [
      '2001:db8::zz',
      '2001:db8::1:2:3:4:5:6:7',
      '[2001:db8::1',
      '[2001:db8::1]:',
      '[2001:db8::1]:99999',
      '[2001:db8::1]x',
      'https://node.example.com',
      'node.example.com:0',
      'node.example.com:abc',
      'fe80::1%eth0',
      'a b c',
    ]) {
      expect(create(bad).success, bad).toBe(false);
    }
  });

  it('the update takes it too', () => {
    expect(UpdateNodeSchema.parse({ address: '[2001:db8::1]:1337' }).address).toBe('2001:db8::1');
  });
});
