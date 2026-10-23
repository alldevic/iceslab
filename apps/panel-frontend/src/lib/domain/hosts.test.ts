import { describe, expect, it } from 'vitest';
import { hiddenLineStart, hostHiddenFacts, hostPortPayload, hostPortShared } from '@/lib/domain/hosts';

describe('hostPortPayload (A-150)', () => {
  const stored = { listenPort: 443, clientPort: null };

  it('правка без смены портов не шлёт ни port, ни portOverride', () => {
    expect(hostPortPayload(stored, { port: 443, clientPort: '' })).toEqual({});
  });

  it('смена поля «Порт» шлёт port (порт прослушки), не portOverride', () => {
    expect(hostPortPayload(stored, { port: 8443, clientPort: '' })).toEqual({ port: 8443 });
  });

  it('«Порт для клиента» шлёт portOverride, очистка шлёт null', () => {
    expect(hostPortPayload(stored, { port: 443, clientPort: 2053 })).toEqual({ portOverride: 2053 });
    expect(hostPortPayload({ listenPort: 443, clientPort: 2053 }, { port: 443, clientPort: '' })).toEqual({
      portOverride: null,
    });
  });

  it('создание: port всегда, portOverride только если задан руками', () => {
    expect(hostPortPayload(null, { port: 443, clientPort: '' })).toEqual({ port: 443 });
    expect(hostPortPayload(null, { port: 443, clientPort: 2053 })).toEqual({ port: 443, portOverride: 2053 });
  });
});

describe('hostPortShared (A-150)', () => {
  const res = (status: number, data: unknown) => ({ response: { status, data } });
  it('409 HOST_PORT_SHARED: порт и имена других хостов', () => {
    expect(hostPortShared(res(409, { error: 'HOST_PORT_SHARED', message: 'm', port: 8443, hosts: ['cdn', 7, ''] }))).toEqual({
      port: 8443,
      hosts: ['cdn'],
    });
  });
  it('вход проверяется первым, чужие 409 не этот отказ', () => {
    for (const e of [null, 'x', new Error('x'), { response: null }]) expect(hostPortShared(e)).toBeNull();
    expect(hostPortShared(res(409, { error: 'PORT_IN_USE', port: 1, hosts: [] }))).toBeNull();
    expect(hostPortShared(res(400, { error: 'HOST_PORT_SHARED', port: 1, hosts: [] }))).toBeNull();
  });
});

/**
 * Хост на ноде, которая в каскаде не вход: подписка его не выдаёт никому, пока
 * каскад включён. Три входа, два из них молчат.
 */
describe('hostHiddenFacts', () => {
  it('1. ключа нет (бэкенд старше поля): молчим', () => {
    expect(hostHiddenFacts({}, 'de-01')).toBeNull();
  });

  it('2. null: хост не скрыт, молчим', () => {
    expect(hostHiddenFacts({ hiddenByCascade: null }, 'de-01')).toBeNull();
  });

  it('3. скрыт каскадом: нода, каскад и его id для ссылки', () => {
    expect(
      hostHiddenFacts({ hiddenByCascade: { cascadeId: 'c1', cascadeName: 'ru-de-relay' } }, 'de-01'),
    ).toEqual({ nodeName: 'de-01', cascadeId: 'c1', cascadeName: 'ru-de-relay' });
  });

  it('4. хоста нет вовсе: молчим, а не падаем', () => {
    expect(hostHiddenFacts(null, 'de-01')).toBeNull();
    expect(hostHiddenFacts(undefined, 'de-01')).toBeNull();
  });

  const byNode = { hiddenByCascade: { cascadeId: 'c2', cascadeName: 'node-fact' } };

  it('5. хоста нет, нода скрыта: говорит факт ноды (окно до развёртывания)', () => {
    expect(hostHiddenFacts(undefined, 'de-01', byNode)).toEqual({
      nodeName: 'de-01',
      cascadeId: 'c2',
      cascadeName: 'node-fact',
    });
  });

  it('6. факт хоста главный: и объект, и null у хоста перебивают ноду', () => {
    expect(
      hostHiddenFacts({ hiddenByCascade: { cascadeId: 'c1', cascadeName: 'host-fact' } }, 'de-01', byNode)
        ?.cascadeName,
    ).toBe('host-fact');
    expect(hostHiddenFacts({ hiddenByCascade: null }, 'de-01', byNode)).toBeNull();
  });

  it('7. у хоста ключа нет (старый бэкенд), у ноды есть: говорит нода; у ноды тоже нет: молчим', () => {
    expect(hostHiddenFacts({}, 'de-01', byNode)?.cascadeId).toBe('c2');
    expect(hostHiddenFacts({}, 'de-01', {})).toBeNull();
    expect(hostHiddenFacts(undefined, 'de-01', { hiddenByCascade: null })).toBeNull();
  });

  it('8. A-234: нода неизвестна (список не пришёл): факт хоста стоит, имя null, и строка говорит «неизвестно», а не «?»', () => {
    const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? ' ' + JSON.stringify(vars) : ''}`;
    const facts = hostHiddenFacts({ hiddenByCascade: { cascadeId: 'c1', cascadeName: 'relay' } }, null);
    expect(facts).toEqual({ nodeName: null, cascadeId: 'c1', cascadeName: 'relay' });
    expect(hiddenLineStart(facts!, t)).toBe('hostHidden.beforeUnknown');
    expect(hiddenLineStart({ nodeName: 'de-01' }, t)).toBe('hostHidden.before {"node":"de-01"}');
  });
});
