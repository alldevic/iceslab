import { describe, expect, it } from 'vitest';
import { defaultPresetOf, routesPaneFailure } from '@/contours/traffic/lib/routesView';

const ok = (data: unknown) => ({ data, isError: false, error: null, refetch: () => undefined });
const failed = { data: undefined, isError: true, error: 'boom', refetch: () => undefined };
const pending = { data: undefined, isError: false, error: null, refetch: () => undefined };
const say = (e: unknown) => `said ${String(e)}`;

describe('defaultPresetOf (A-228)', () => {
  it('настройки не пришли: null, а не proxy-all', () => {
    expect(defaultPresetOf(undefined)).toBeNull();
  });

  it('настройки пришли без пресета: proxy-all; с пресетом: он', () => {
    expect(defaultPresetOf({})).toBe('proxy-all');
    expect(defaultPresetOf({ subscriptionRoutingPreset: null })).toBe('proxy-all');
    expect(defaultPresetOf({ subscriptionRoutingPreset: 'proxy-all' })).toBe('proxy-all');
  });
});

describe('routesPaneFailure (A-228)', () => {
  const lists = { routePolicies: ok({ policies: [] }), squads: ok({ squads: [] }), settings: ok({}) };

  it('сбой списка открытой вкладки даёт отказ с повтором, а не пусто', () => {
    const node = routesPaneFailure('node', { ...lists, routePolicies: failed }, say);
    expect(node?.message).toBe('said boom');
    expect(routesPaneFailure('device', { ...lists, settings: failed }, say)?.message).toBe('said boom');
    expect(routesPaneFailure('device', { ...lists, squads: failed }, say)).not.toBeNull();
  });

  it('пустой ответ это не сбой; чужой список вкладку не роняет; ожидание не сбой', () => {
    expect(routesPaneFailure('node', lists, say)).toBeNull();
    expect(routesPaneFailure('node', { ...lists, settings: failed }, say)).toBeNull();
    expect(routesPaneFailure('policy', { ...lists, routePolicies: failed }, say)).toBeNull();
    expect(routesPaneFailure('node', { ...lists, routePolicies: pending }, say)).toBeNull();
  });
});
