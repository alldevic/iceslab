import { describe, expect, it } from 'vitest';
import { subscriptionLink } from '@/contours/users/lib/subscriptionLink';

const say = () => 'said';
const q = (data: unknown, isError: boolean) => ({ data: data as never, isError, error: null, refetch: () => undefined });

describe('subscriptionLink (spec frontend-users, A-207)', () => {
  it('статус пришёл: адрес и префикс из статуса, свой только токен', () => {
    expect(subscriptionLink('tok', q({ panel: { publicUrl: 'https://p.example', subscriptionPathPrefix: '/s' } }, false), say)).toEqual({
      kind: 'ready',
      url: 'https://p.example/s/tok',
    });
    // Хост из настроек панели (A-171) приходит тем же полем, экран его не отличает.
    expect(subscriptionLink('tok', q({ panel: { publicUrl: 'https://nw.example.com', subscriptionPathPrefix: '/v' } }, false), say)).toEqual({
      kind: 'ready',
      url: 'https://nw.example.com/v/tok',
    });
  });

  it('статус без адреса: ссылки нет, без своего хоста и своего /sub', () => {
    for (const data of [
      {},
      { panel: null },
      { panel: { subscriptionPathPrefix: '/sub' } },
      { panel: { publicUrl: '', subscriptionPathPrefix: '/sub' } },
      { panel: { publicUrl: 'p.example', subscriptionPathPrefix: '/sub' } },
      { panel: { publicUrl: 'https://p.example' } },
      { panel: { publicUrl: 'https://p.example', subscriptionPathPrefix: 'sub' } },
      { panel: { publicUrl: 42, subscriptionPathPrefix: '/sub' } },
    ]) {
      expect(subscriptionLink('tok', q(data, false), say)).toEqual({ kind: 'absent' });
    }
  });

  it('статус не пришёл: ссылки нет, «не вышло» с повтором; пока идёт: загрузка', () => {
    const failed = subscriptionLink('tok', q(undefined, true), say);
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' && failed.message).toBe('said');
    expect(subscriptionLink('tok', q(undefined, false), say)).toEqual({ kind: 'loading' });
  });
});
