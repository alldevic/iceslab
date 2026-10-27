import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ALL_SQUAD_ID } from '@/lib/domain/routePolicies';
import { isSystemSquad, NO_ACCESS_SQUAD_ID, systemSquadDescription, systemSquadName } from '@/lib/domain/squads';

describe('системные сквады: All и «Без доступа» фасада', () => {
  const t = ((key: string) => `t:${key}`) as unknown as TFunction;
  const row = (id: string) => ({ id, name: `row ${id}`, description: 'row description' });

  it('оба системные, обычный сквад нет', () => {
    expect(isSystemSquad(row(ALL_SQUAD_ID))).toBe(true);
    expect(isSystemSquad(row(NO_ACCESS_SQUAD_ID))).toBe(true);
    expect(isSystemSquad(row('vip'))).toBe(false);
  });

  it('имя и описание системных из i18n, обычного из строки', () => {
    expect(systemSquadName(row(ALL_SQUAD_ID), t)).toBe('t:squads.allDefaultName');
    expect(systemSquadName(row(NO_ACCESS_SQUAD_ID), t)).toBe('t:squads.noAccessName');
    expect(systemSquadDescription(row(NO_ACCESS_SQUAD_ID), t)).toBe('t:squads.noAccessDescription');
    expect(systemSquadName(row('vip'), t)).toBe('row vip');
    expect(systemSquadDescription(row('vip'), t)).toBe('row description');
  });
});
