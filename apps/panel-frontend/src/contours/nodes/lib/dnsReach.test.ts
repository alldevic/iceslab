import { describe, expect, it } from 'vitest';
import { dnsReach } from '@/contours/nodes/lib/dnsReach';
import type { NodeCore } from '@/lib/domain/nodes';

/** Core as the agent sends it; the type comes from the contract. */
function core(p: Partial<NodeCore>): NodeCore {
  return { name: 'xray', ...p } as NodeCore;
}

describe('dnsReach', () => {
  it('no report at all, or an empty one: unknown, not «no cores»', () => {
    expect(dnsReach(undefined).state).toBe('unknown');
    expect(dnsReach(null).state).toBe('unknown');
    expect(dnsReach([]).state).toBe('unknown');
  });

  it('xray executes: executes, with the core named', () => {
    expect(dnsReach([core({ rendersDns: true })])).toEqual({
      state: 'executes',
      executing: ['xray'],
      notExecuting: [],
      unknown: [],
    });
  });

  it('xray and hysteria: executes for xray, hysteria listed as the gap', () => {
    const r = dnsReach([core({ rendersDns: true }), core({ name: 'hysteria', rendersDns: false })]);
    expect(r.state).toBe('executes');
    expect(r.executing).toEqual(['xray']);
    expect(r.notExecuting).toEqual(['hysteria']);
  });

  it('everybody answered «no»: not-executes', () => {
    const r = dnsReach([core({ name: 'hysteria', rendersDns: false }), core({ name: 'amneziawg', rendersDns: false })]);
    expect(r.state).toBe('not-executes');
    expect(r.notExecuting).toEqual(['hysteria', 'amneziawg']);
  });

  it('no core sent rendersDns: unknown, never not-executes', () => {
    const r = dnsReach([core({ name: 'hysteria' }), core({ name: 'mieru' })]);
    expect(r.state).toBe('unknown');
    expect(r.unknown).toEqual(['hysteria', 'mieru']);
    expect(r.notExecuting).toEqual([]);
  });

  it('one said «no», one is silent: unknown, a refusal on a partial list is forbidden', () => {
    const r = dnsReach([core({ name: 'hysteria', rendersDns: false }), core({ name: 'mieru' })]);
    expect(r.state).toBe('unknown');
    expect(r.notExecuting).toEqual(['hysteria']);
    expect(r.unknown).toEqual(['mieru']);
  });

  it('one executes, one is silent: executes (a partial answer may say yes)', () => {
    const r = dnsReach([core({ rendersDns: true }), core({ name: 'mieru' })]);
    expect(r.state).toBe('executes');
    expect(r.unknown).toEqual(['mieru']);
  });

  it('can render but the binary is missing: not-executes', () => {
    expect(dnsReach([core({ rendersDns: true, installed: false })]).state).toBe('not-executes');
  });

  it('a field that is absent on installed is not «missing»', () => {
    expect(dnsReach([core({ rendersDns: true })]).state).toBe('executes');
  });

  it('an idle core (provisioned === false) is not counted either way', () => {
    const r = dnsReach([core({ rendersDns: true }), core({ name: 'hysteria', rendersDns: false, provisioned: false })]);
    expect(r.notExecuting).toEqual([]);
    expect(r.state).toBe('executes');
  });

  it('an engine other than the core name is spelled in the label', () => {
    const r = dnsReach([core({ name: 'hysteria', engine: 'singbox', rendersDns: false })]);
    expect(r.notExecuting).toEqual(['hysteria (singbox)']);
  });
});
