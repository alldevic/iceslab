import { describe, expect, it } from 'vitest';
import type { NodeCoreInfo } from '@iceslab/shared';
import type { DnsSkippedRule, PresetNode } from '@/lib/domain/routePolicies';
import { nodeDnsMark, summarizePresetNodes } from '@/contours/traffic/lib/presetNodes';

const core = (name: string, rendersDns?: boolean): NodeCoreInfo => ({ name: name as NodeCoreInfo['name'], provisioned: true, installed: true, ...(rendersDns === undefined ? {} : { rendersDns }) });
const node = (over: Partial<PresetNode> & { id: string }): PresetNode => ({
  name: over.id,
  online: true,
  state: 'sent',
  carried: 1,
  cores: [core('xray', true)],
  skipped: [],
  ...over,
});
const skip = (kind: DnsSkippedRule['kind']): DnsSkippedRule => ({ index: 0, kind });

describe('nodeDnsMark', () => {
  it('reads the cores the way the DNS page does', () => {
    expect(nodeDnsMark({ cores: [core('xray', true)] })).toBe('executes');
    expect(nodeDnsMark({ cores: [core('hysteria', false)] })).toBe('not-executes');
    expect(nodeDnsMark({ cores: [core('xray', true), core('hysteria', false)] })).toBe('partial');
  });

  it('a node that has not reported, or whose agent predates the field, is unknown and not «does not execute»', () => {
    expect(nodeDnsMark({ cores: null })).toBe('unknown');
    expect(nodeDnsMark({ cores: [core('xray')] })).toBe('unknown');
    expect(nodeDnsMark({ cores: [core('xray'), core('hysteria', false)] })).toBe('unknown');
  });
});

describe('summarizePresetNodes', () => {
  it('counts nothing for a preset that reaches no node', () => {
    expect(summarizePresetNodes({ nodes: [] })).toEqual({ nodes: 0, receiving: 0, sent: 0, waiting: 0, notExecuting: 0, partial: 0, unknown: 0, overridden: 0, leftOut: 0, serverKind: 0 });
  });

  it('counts the nodes by the state of the transfer, the cores, and what was not carried', () => {
    const s = summarizePresetNodes({
      nodes: [
        node({ id: 'a' }),
        node({ id: 'b', state: 'waiting', cores: [core('hysteria', false)] }),
        node({ id: 'c', state: 'waiting', cores: null, skipped: [skip('manual')] }),
        node({ id: 'd', cores: [core('xray', true), core('amneziawg', false)], skipped: [skip('server-kind'), skip('manual')] }),
        node({ id: 'e', state: 'none', carried: 0, cores: [core('hysteria', false)], skipped: [skip('conflict')] }),
        node({ id: 'f', state: 'none', carried: 0, cores: null, skipped: [skip('limit')] }),
      ],
    });
    expect(s).toEqual({ nodes: 6, receiving: 4, sent: 2, waiting: 2, notExecuting: 1, partial: 1, unknown: 1, overridden: 2, leftOut: 2, serverKind: 1 });
  });

  it('a node that carries none of the rules is not marked for its cores', () => {
    const s = summarizePresetNodes({ nodes: [node({ id: 'x', state: 'none', carried: 0, cores: [core('hysteria', false)] })] });
    expect(s).toMatchObject({ nodes: 1, receiving: 0, notExecuting: 0 });
  });
});
