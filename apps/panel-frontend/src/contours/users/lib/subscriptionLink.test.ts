import { describe, expect, it } from 'vitest';
import { subscriptionLink } from '@/contours/users/lib/subscriptionLink';

const say = () => 'said';
const q = (data: unknown, isError: boolean) => ({ data: data as never, isError, error: null, refetch: () => undefined });

describe('subscriptionLink (spec frontend-users)', () => {
  it('статус пришёл: ссылка от публичного адреса панели', () => {
    expect(subscriptionLink('tok', q({ panel: { publicUrl: 'https://p.example', subscriptionPathPrefix: '/s' } }, false), say)).toEqual({
      kind: 'ready',
      url: 'https://p.example/s/tok',
    });
  });

  it('статус не пришёл: ссылки нет, «не вышло» с повтором; пока идёт: загрузка', () => {
    const failed = subscriptionLink('tok', q(undefined, true), say);
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' && failed.message).toBe('said');
    expect(subscriptionLink('tok', q(undefined, false), say)).toEqual({ kind: 'loading' });
  });
});
