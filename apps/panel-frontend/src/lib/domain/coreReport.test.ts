import { describe, expect, it } from 'vitest';
import type { NodeCoreInfo } from '@iceslab/shared';
import { coreFault, coreUncounted, uncountedNodes } from '@/lib/domain/coreReport';

const core = (c: Partial<NodeCoreInfo>) => ({ name: 'tuic', ...c }) as NodeCoreInfo;

describe('coreReport (контракт 49699f88)', () => {
  it('без учёта трафика только при false; true и отсутствие поля молчат', () => {
    expect(coreUncounted(core({ countsUsers: false }))).toBe(true);
    expect(coreUncounted(core({ countsUsers: true }))).toBe(false);
    expect(coreUncounted(core({}))).toBe(false);
  });

  it('поломка ядра: строка агента, пустое и отсутствие молчат', () => {
    expect(coreFault(core({ error: ' ssm-api sync pending: dial ' }))).toBe('ssm-api sync pending: dial');
    expect(coreFault(core({ error: '' }))).toBeNull();
    expect(coreFault(core({}))).toBeNull();
  });

  it('ноды, где движок не считает трафик по юзеру', () => {
    const nodes = [
      { id: 'a', name: 'A', cores: { cores: [core({ engine: 'singbox', countsUsers: false })] } },
      { id: 'b', name: 'B', cores: { cores: [core({ engine: 'singbox', countsUsers: true })] } },
      { id: 'c', name: 'C', cores: { cores: [core({ name: 'naive', countsUsers: false })] } },
      { id: 'd', name: 'D', cores: null },
    ];
    expect(uncountedNodes(nodes, 'singbox')).toEqual([{ id: 'a', name: 'A' }]);
    expect(uncountedNodes(nodes, 'naive')).toEqual([{ id: 'c', name: 'C' }]);
    expect(uncountedNodes(nodes, 'xray')).toEqual([]);
  });
});
