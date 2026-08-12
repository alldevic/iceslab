import { describe, expect, it } from 'vitest';
import {
  mapUserToRemna,
  bytesToNativeLimit,
  hwidLimitToNative,
  strategyToNative,
  statusToNative,
  subscriptionUrlFor,
} from './remnawave.mappers.js';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID } from '../squads/squads.constants.js';
import type { PublicUserDto } from '../users/users.mapper.js';

function dto(overrides: Partial<PublicUserDto> = {}): PublicUserDto {
  return {
    id: 'u-1',
    shortId: 'short1',
    username: 'alice',
    status: 'active',
    expireAt: '2026-01-02T03:04:05.678Z',
    trafficLimitBytes: null,
    trafficUsedBytes: 111,
    lifetimeTrafficBytes: 222,
    trafficLimitStrategy: 'no_reset',
    lastTrafficResetAt: null,
    lastOnlineAt: null,
    subscriptionToken: 'tok-abc',
    subRevokedAt: null,
    hwidDeviceLimit: null,
    routingPreset: null,
    description: null,
    tag: null,
    telegramId: null,
    email: null,
    externalSquadUuid: null,
    enabledProtocols: ['hysteria'],
    groupIds: [],
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mapUserToRemna — status + strategy enums (native lower → Remnawave upper)', () => {
  it('uppercases status incl. LIMITED/EXPIRED', () => {
    expect(mapUserToRemna(dto({ status: 'active' })).status).toBe('ACTIVE');
    expect(mapUserToRemna(dto({ status: 'disabled' })).status).toBe('DISABLED');
    expect(mapUserToRemna(dto({ status: 'limited' })).status).toBe('LIMITED');
    expect(mapUserToRemna(dto({ status: 'expired' })).status).toBe('EXPIRED');
  });

  it('maps trafficLimitStrategy incl. rolling → MONTH_ROLLING', () => {
    expect(mapUserToRemna(dto({ trafficLimitStrategy: 'no_reset' })).trafficLimitStrategy).toBe('NO_RESET');
    expect(mapUserToRemna(dto({ trafficLimitStrategy: 'day' })).trafficLimitStrategy).toBe('DAY');
    expect(mapUserToRemna(dto({ trafficLimitStrategy: 'rolling' })).trafficLimitStrategy).toBe('MONTH_ROLLING');
  });
});

describe('mapUserToRemna — unlimited = 0 (both limit fields)', () => {
  it('emits trafficLimitBytes 0 and hwidDeviceLimit 0 for null (unlimited)', () => {
    const m = mapUserToRemna(dto({ trafficLimitBytes: null, hwidDeviceLimit: null }));
    // Remnawave represents unlimited as 0; the minishop entitlement-verifies
    // its sent 0 against these — null would roll back paid activations.
    expect(m.trafficLimitBytes).toBe(0);
    expect(m.hwidDeviceLimit).toBe(0);
  });

  it('passes real limits through', () => {
    const m = mapUserToRemna(dto({ trafficLimitBytes: 5000, hwidDeviceLimit: 3 }));
    expect(m.trafficLimitBytes).toBe(5000);
    expect(m.hwidDeviceLimit).toBe(3);
  });
});

describe('mapUserToRemna — identity + externalSquadUuid + subscriptionUrl', () => {
  it('exposes subscriptionToken as shortUuid/subscriptionUuid and builds subscriptionUrl', () => {
    const m = mapUserToRemna(dto({ subscriptionToken: 'tok-abc' }));
    expect(m.shortUuid).toBe('tok-abc');
    expect(m.subscriptionUuid).toBe('tok-abc');
    expect(m.subscriptionUrl).toBe(subscriptionUrlFor('tok-abc'));
  });

  it('always emits externalSquadUuid key (null when unset) — minishop treats a missing key as present=false', () => {
    expect(mapUserToRemna(dto({ externalSquadUuid: null })).externalSquadUuid).toBeNull();
    expect(mapUserToRemna(dto({ externalSquadUuid: 'ext-9' })).externalSquadUuid).toBe('ext-9');
    // key must be present even when null
    expect('externalSquadUuid' in mapUserToRemna(dto())).toBe(true);
  });

  it('telegramId → number', () => {
    expect(mapUserToRemna(dto({ telegramId: '12345' })).telegramId).toBe(12345);
    expect(mapUserToRemna(dto({ telegramId: null })).telegramId).toBeNull();
  });
});

describe('mapUserToRemna — activeInternalSquads hides the system groups', () => {
  it('drops ALL_SQUAD_ID and NO_ACCESS_SQUAD_ID, keeps real squads with names', () => {
    const names = new Map([
      ['real-1', 'RU'],
      [ALL_SQUAD_ID, 'All'],
      [NO_ACCESS_SQUAD_ID, 'No access'],
    ]);
    const m = mapUserToRemna(
      dto({ groupIds: ['real-1', ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID] }),
      { squadNames: names, hiddenGroupIds: new Set([ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID]) },
    );
    expect(m.activeInternalSquads).toEqual([{ uuid: 'real-1', name: 'RU' }]);
  });

  it('falls back to the id when no name is known', () => {
    const m = mapUserToRemna(dto({ groupIds: ['real-2'] }), { hiddenGroupIds: new Set() });
    expect(m.activeInternalSquads).toEqual([{ uuid: 'real-2', name: 'real-2' }]);
  });
});

describe('bytesToNativeLimit — 0/negative/null → null (unlimited), else byte-exact', () => {
  it('unlimited', () => {
    expect(bytesToNativeLimit(null)).toBeNull();
    expect(bytesToNativeLimit(undefined)).toBeNull();
    expect(bytesToNativeLimit(0)).toBeNull();
    expect(bytesToNativeLimit(-5)).toBeNull();
  });
  it('passes bytes through UNQUANTIZED — no GiB rounding (the shop exact-int-verifies)', () => {
    // Whole GiB round-trips (as before)…
    expect(bytesToNativeLimit(1_073_741_824)).toBe(1_073_741_824);
    expect(bytesToNativeLimit(53_687_091_200)).toBe(53_687_091_200);
    // …but so must NON-GiB-aligned values (carryover / topup / fractional-GB):
    // the old bytesToGb would have rounded these to a different byte count and
    // the shop would have rolled back the paid activation.
    expect(bytesToNativeLimit(13_237_418_240)).toBe(13_237_418_240); // 2.5 GB used + 10 GiB
    expect(bytesToNativeLimit(536_870_912)).toBe(536_870_912); // 0.5 GiB fractional tariff
    expect(bytesToNativeLimit(1)).toBe(1);
  });
});

describe('hwidLimitToNative — <=0 → null (unlimited)', () => {
  it('maps 0 and negatives to null', () => {
    expect(hwidLimitToNative(0)).toBeNull();
    expect(hwidLimitToNative(-1)).toBeNull();
    expect(hwidLimitToNative(null)).toBeNull();
    expect(hwidLimitToNative(undefined)).toBeNull();
  });
  it('passes positive limits through', () => {
    expect(hwidLimitToNative(3)).toBe(3);
  });
});

describe('strategyToNative / statusToNative', () => {
  it('maps Remnawave strategy → native, unknown → no_reset, undefined → undefined', () => {
    expect(strategyToNative('MONTH_ROLLING')).toBe('rolling');
    expect(strategyToNative('NO_RESET')).toBe('no_reset');
    expect(strategyToNative('WEIRD')).toBe('no_reset');
    expect(strategyToNative(undefined)).toBeUndefined();
  });
  it('maps only ACTIVE/DISABLED as input; ignores cron-managed states', () => {
    expect(statusToNative('ACTIVE')).toBe('active');
    expect(statusToNative('DISABLED')).toBe('disabled');
    expect(statusToNative('LIMITED')).toBeUndefined();
    expect(statusToNative('EXPIRED')).toBeUndefined();
    expect(statusToNative(undefined)).toBeUndefined();
  });
});
