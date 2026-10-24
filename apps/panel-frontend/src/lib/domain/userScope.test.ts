import { describe, expect, it } from 'vitest';
import { MULTI_INBOUND_ADAPTERS, nativeEngineFor, PROTOCOL_NAMES } from '@iceslab/shared';
import { SCOPED_USER_ENGINES, userScopeGap } from '@/lib/domain/userScope';

/**
 * The agent's adapters, read as source (the way linkCongestion.test reads the
 * screens): which of them put a user on named inbounds only. The list in
 * userScope.ts is checked against them, not against a copy of itself.
 */
const ADAPTERS = import.meta.glob('../../../../node/internal/core/*/adapter.go', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const engineOf = (path: string) => path.split('/').at(-2)!;

describe('userScopeGap (A-204): где ограничение сквада по юзеру на ноде не действует', () => {
  it('1. глоб читает адаптеры агента, а не пустоту', () => {
    expect(Object.keys(ADAPTERS).map(engineOf)).toEqual(expect.arrayContaining(['xray', 'mieru', 'mtproto']));
  });

  it('2. список адаптеров с AddUserOn совпадает с исходниками агента', () => {
    const scoped = Object.entries(ADAPTERS)
      .filter(([, code]) => /func \(a \*Adapter\) AddUserOn\(/.test(code))
      .map(([path]) => engineOf(path))
      .sort();
    expect(scoped).toEqual([...SCOPED_USER_ENGINES].sort());
  });

  it('3. mtproto один секрет на всех: так и написано у адаптера', () => {
    const mtproto = Object.entries(ADAPTERS).find(([path]) => engineOf(path) === 'mtproto')?.[1] ?? '';
    expect(mtproto).toMatch(/single-secret/);
    expect(userScopeGap({ protocol: 'mtproto', effectiveEngine: 'mtproto' })).toBe('shared-secret');
  });

  it('4. несколько входов на ноде без AddUserOn это mieru; у xray, sing-box и AmneziaWG разрыва нет', () => {
    expect(userScopeGap({ protocol: 'mieru', effectiveEngine: 'mieru' })).toBe('shared-users');
    expect(userScopeGap({ protocol: 'xray', effectiveEngine: 'xray' })).toBeNull();
    expect(userScopeGap({ protocol: 'tuic', effectiveEngine: 'singbox' })).toBeNull();
    expect(userScopeGap({ protocol: 'amneziawg', effectiveEngine: 'amneziawg', awgProtocol: 3 })).toBeNull();
    expect(userScopeGap({ protocol: 'hysteria', effectiveEngine: 'hysteria' })).toBeNull();
  });

  it('5. по контракту: каждый протокол на родном движке, разрыв ровно там, где мульти без AddUserOn, и у mtproto', () => {
    for (const protocol of PROTOCOL_NAMES) {
      const engine = nativeEngineFor(protocol);
      const multi = MULTI_INBOUND_ADAPTERS.includes(`${protocol}|${engine}`);
      const want = protocol === 'mtproto' ? 'shared-secret' : multi && !SCOPED_USER_ENGINES.includes(engine) ? 'shared-users' : null;
      expect(userScopeGap({ protocol, effectiveEngine: engine })).toBe(want);
    }
  });
});
