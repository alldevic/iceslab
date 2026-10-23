import { describe, expect, it } from 'vitest';
import { deliveryRouting, type PresetRef } from '@/lib/domain/users';
import { routingRow, type DeliveryView } from '@/contours/users/lib/routingRow';

const OWN = '7f1c0000-0000-4000-8000-000000000001';
const ownRef: PresetRef = { builtIn: false, id: OWN, name: 'Мой сплит' };
const ru: PresetRef = { builtIn: true, id: 'ru-split', name: 'ru-split' };

const base = {
  squads: { source: null, clash: false },
  choiceName: (c: string) => (c === OWN ? 'Мой сплит' : c === '' ? null : `built:${c}`),
  refName: (r: PresetRef) => (r.builtIn ? `built:${r.id}` : r.name),
  words: { inherits: 'inherits', unnamed: 'unnamed', unknown: 'unknown', loading: 'loading' },
};
const ready = (data: unknown): DeliveryView => ({ kind: 'ready', routing: deliveryRouting(data) });

describe('deliveryRouting (A-229)', () => {
  it('reads the resolved fields, own presets included', () => {
    expect(
      deliveryRouting({ routing: { user: null, source: 'user', effectivePreset: ownRef, userPreset: ownRef, squadPreset: null } }),
    ).toEqual({ effective: ownRef, user: ownRef, squad: null, squadConflict: false });
  });

  it('a server without them, or with one malformed, is null: unknown, not «no preset»', () => {
    expect(deliveryRouting({ routing: { effective: 'proxy-all', user: null } })).toBeNull();
    expect(deliveryRouting({ routing: { effectivePreset: ownRef, userPreset: { id: 1 }, squadPreset: null } })).toBeNull();
    expect(deliveryRouting({ routing: { effectivePreset: ownRef, squadPreset: null } })).toBeNull();
    expect(deliveryRouting(null)).toBeNull();
  });
});

describe('routingRow (A-229)', () => {
  it('the card with an own preset names it, though the old field `user` is null', () => {
    const row = routingRow({
      ...base,
      draft: OWN,
      seed: OWN,
      delivery: ready({ routing: { user: null, source: 'user', effectivePreset: ownRef, userPreset: ownRef, squadPreset: null } }),
    });
    expect(row).toEqual({ value: 'Мой сплит', note: { key: 'userDrawer.routingOwn' } });
  });

  it('an own preset from a squad is named with the squad the form sees', () => {
    const row = routingRow({
      ...base,
      draft: '',
      seed: '',
      squads: { source: { choice: OWN, squad: 'VIP' }, clash: false },
      delivery: ready({ routing: { effectivePreset: ownRef, userPreset: null, squadPreset: ownRef } }),
    });
    expect(row).toEqual({ value: 'Мой сплит', note: { key: 'userDrawer.routingFromSquad', vars: { squad: 'VIP' } } });
  });

  it('nothing set: the panel default the server names', () => {
    const row = routingRow({ ...base, draft: '', seed: '', delivery: ready({ routing: { effectivePreset: ru, userPreset: null, squadPreset: null } }) });
    expect(row).toEqual({ value: 'built:ru-split', note: { key: 'userDrawer.routingFromPanel' } });
  });

  it('the answer failed or is on its way: said, not «inherits»', () => {
    expect(routingRow({ ...base, draft: '', seed: '', delivery: { kind: 'failed' } })).toEqual({
      value: 'unknown',
      note: { key: 'userDrawer.routingFailed' },
    });
    expect(routingRow({ ...base, draft: '', seed: '', delivery: { kind: 'loading' } }).value).toBe('loading');
  });

  it('a moved picker is the draft, not what the server serves yet', () => {
    const row = routingRow({ ...base, draft: 'cn-split', seed: OWN, delivery: ready({ routing: { effectivePreset: ownRef, userPreset: ownRef, squadPreset: null } }) });
    expect(row).toEqual({ value: 'built:cn-split', note: null });
  });

  it('an older server without the resolved fields falls back to the form', () => {
    const row = routingRow({
      ...base,
      draft: '',
      seed: '',
      squads: { source: { choice: 'ru-split', squad: 'basic' }, clash: false },
      delivery: ready({ routing: { effective: 'ru-split', source: 'squad' } }),
    });
    expect(row).toEqual({ value: 'built:ru-split', note: { key: 'userDrawer.routingFromSquad', vars: { squad: 'basic' } } });
  });

  it('a new user is drawn from the form alone', () => {
    expect(routingRow({ ...base, draft: OWN, seed: null, delivery: { kind: 'loading' } }).value).toBe('Мой сплит');
    expect(routingRow({ ...base, draft: '', seed: null, delivery: { kind: 'loading' }, squads: { source: null, clash: true } })).toEqual({
      value: 'inherits',
      note: { key: 'userDrawer.routingClashChip' },
    });
  });
});
