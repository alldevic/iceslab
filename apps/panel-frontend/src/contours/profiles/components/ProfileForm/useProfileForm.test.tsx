// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Profile } from '@/lib/domain/profiles';
import { useProfileForm } from '@/contours/profiles/components/ProfileForm/useProfileForm';
import { xrayFieldReactions } from '@/contours/profiles/lib/xrayFieldReactions';

/*
 * Три реакции формы профиля ушли из useEffect в onValuesChange (25.09), без
 * подавлений exhaustive-deps. Видимое поведение то же: это и проверяется.
 */

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

const xrayProfile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: 'p1',
    name: 'de-reality',
    description: null,
    protocol: 'xray',
    engine: null,
    effectiveEngine: 'xray',
    enabled: true,
    config: { subprotocol: 'vless', security: 'reality', network: 'raw', flow: 'xtls-rprx-vision' },
    ...over,
  }) as unknown as Profile;

const render = (profile: Profile | null) =>
  renderHook(
    ({ p }: { p: Profile | null }) =>
      useProfileForm({ profile: p, opened: true, mode: 'create', onSubmit: async () => {}, onClose: () => {} }),
    { wrapper, initialProps: { p: profile } },
  );

describe('useProfileForm: реакции на смену поля', () => {
  it('транспорт grpc при пустом serviceName: GunService; Vision снят', () => {
    const { result } = render(xrayProfile());
    act(() => {
      result.current.form.setFieldValue('xrayServiceName', '');
      result.current.form.setFieldValue('xrayNetwork', 'grpc');
    });
    expect(result.current.form.values.xrayServiceName).toBe('GunService');
    expect(result.current.form.values.xrayFlow).toBe('');
  });

  it('оператор очистил serviceName после grpc: остаётся пустым, обратно не заполняется', () => {
    const { result } = render(xrayProfile());
    act(() => result.current.form.setFieldValue('xrayNetwork', 'grpc'));
    act(() => result.current.form.setFieldValue('xrayServiceName', ''));
    expect(result.current.form.values.xrayServiceName).toBe('');
  });

  it('vmess при REALITY: security none; смена security потом не трогается', () => {
    const { result } = render(xrayProfile());
    act(() => result.current.form.setFieldValue('xraySubprotocol', 'vmess'));
    expect(result.current.form.values.xraySecurity).toBe('none');
    act(() => result.current.form.setFieldValue('xraySecurity', 'tls'));
    expect(result.current.form.values.xraySecurity).toBe('tls');
  });

  it('REALITY выбрана на ws: транспорт возвращается к raw; на xhttp остаётся', () => {
    const { result } = render(
      xrayProfile({ config: { subprotocol: 'vless', security: 'tls', network: 'ws', flow: '' } as never }),
    );
    act(() => result.current.form.setFieldValue('xraySecurity', 'reality'));
    expect(result.current.form.values.xrayNetwork).toBe('raw');

    act(() => result.current.form.setFieldValue('xraySecurity', 'tls'));
    act(() => result.current.form.setFieldValue('xrayNetwork', 'xhttp'));
    act(() => result.current.form.setFieldValue('xraySecurity', 'reality'));
    expect(result.current.form.values.xrayNetwork).toBe('xhttp');
  });

  it('при TLS ws выбирается и остаётся; сохранённый REALITY+ws при открытии не переписывается молча', () => {
    const tls = render(xrayProfile({ config: { subprotocol: 'vless', security: 'tls', network: 'ws' } as never }));
    expect(tls.result.current.form.values.xrayNetwork).toBe('ws');
    const legacy = render(xrayProfile({ config: { subprotocol: 'vless', security: 'reality', network: 'ws' } as never }));
    expect(legacy.result.current.form.values.xrayNetwork).toBe('ws');
  });

  it('новый объект профиля с тем же id (refetch) не пересевает форму: правка на месте', () => {
    const { result, rerender } = render(xrayProfile());
    act(() => result.current.form.setFieldValue('name', 'edited-by-me'));
    rerender({ p: xrayProfile({ name: 'renamed-elsewhere' }) });
    expect(result.current.form.values.name).toBe('edited-by-me');
    // Другой профиль пересевает.
    rerender({ p: xrayProfile({ id: 'p2', name: 'other' }) });
    expect(result.current.form.values.name).toBe('other');
  });
});

describe('xrayFieldReactions', () => {
  type F = Parameters<typeof xrayFieldReactions>[0];
  const base = {
    xrayNetwork: 'raw',
    xrayServiceName: '',
    xrayFlow: 'xtls-rprx-vision',
    xraySubprotocol: 'vless',
    xraySecurity: 'reality',
  } as F;
  const grpc = 'grpc' as F['xrayNetwork'];
  it('без смены своего поля реакции нет', () => {
    expect(xrayFieldReactions(base, base)).toBeNull();
    expect(xrayFieldReactions({ ...base, xrayNetwork: grpc }, { ...base, xrayNetwork: grpc, xrayServiceName: 'X' })).toBeNull();
  });
  it('security стала REALITY на недопустимом транспорте: транспорт raw; без смены security нет', () => {
    const tls = { ...base, xrayNetwork: 'kcp' as F['xrayNetwork'], xraySecurity: 'tls' as F['xraySecurity'], xrayFlow: '' };
    expect(xrayFieldReactions({ ...tls, xraySecurity: 'reality' }, tls)).toEqual({ xrayNetwork: 'raw' });
    expect(xrayFieldReactions({ ...tls, xraySecurity: 'none' }, tls)).toBeNull();
  });
  it('засев (previous null) применяет всё, как прежние эффекты на первом рендере', () => {
    expect(xrayFieldReactions({ ...base, xrayNetwork: grpc }, null)).toEqual({ xrayServiceName: 'GunService', xrayFlow: '' });
  });
});

/*
 * Правила AmneziaWG (6.5): профиль, который схема откажет, форма не отправляет
 * и называет поле. Ключи правильной формы подставлены: у нового профиля их
 * оператор получает кнопкой «Generate».
 */
describe('useProfileForm: правила AmneziaWG', () => {
  const KEY = 'YAT+bEESM0kh2iD3ujUlW1SQ/HeGjigNdYRs8B5ZSEE=';

  async function submitAwg(over: Record<string, unknown>) {
    const sent: unknown[] = [];
    const { result } = renderHook(
      () =>
        useProfileForm({
          profile: null,
          opened: true,
          mode: 'create',
          onSubmit: async (input) => {
            sent.push(input);
          },
          onClose: () => {},
        }),
      { wrapper },
    );
    act(() =>
      result.current.form.setValues({
        protocol: 'amneziawg',
        name: 'awg',
        awgServerPriv: KEY,
        awgServerPub: KEY,
        ...over,
      }),
    );
    await act(async () => {
      await result.current.form.onSubmit(result.current.handleSubmit)();
    });
    return { sent, errors: result.current.form.errors };
  }

  it('новый профиль с ключами правильной формы уходит', async () => {
    const { sent, errors } = await submitAwg({});
    expect(errors).toEqual({});
    expect(sent).toHaveLength(1);
  });

  it('профиль 3.1 этими правилами не ломается', async () => {
    const { sent, errors } = await submitAwg({ awgGeneration: 3 });
    expect(errors).toEqual({});
    expect(sent).toHaveLength(1);
  });

  it('Jmin больше Jmax: не отправляется, ошибка у Jmax', async () => {
    const { sent, errors } = await submitAwg({ awgJmin: 200, awgJmax: 100 });
    expect(sent).toEqual([]);
    expect(Object.keys(errors)).toEqual(['awgJmax']);
  });

  it('S1 + 56 = S2: не отправляется, ошибка у S2', async () => {
    const { sent, errors } = await submitAwg({ awgS1: 10, awgS2: 66 });
    expect(sent).toEqual([]);
    expect(Object.keys(errors)).toEqual(['awgS2']);
  });

  it('ключ без «=» на конце: не отправляется, ошибка у ключа', async () => {
    const { sent, errors } = await submitAwg({ awgServerPriv: 'a'.repeat(44) });
    expect(sent).toEqual([]);
    expect(Object.keys(errors)).toEqual(['awgServerPriv']);
  });

  it('правила AmneziaWG не трогают другие протоколы', async () => {
    const { sent, errors } = await submitAwg({ protocol: 'naive', awgServerPriv: '', awgJmin: 500 });
    expect(errors).toEqual({});
    expect(sent).toHaveLength(1);
  });
});

/*
 * Обычный WireGuard (9.3): подсеть и два ключа сервера, без обфускации. Тело
 * сохранения не несёт ни `obfuscation`, ни поколения AmneziaWG; профиль, который
 * схема откажет, форма не отправляет и называет поле.
 */
describe('useProfileForm: профиль wireguard', () => {
  const KEY = 'YAT+bEESM0kh2iD3ujUlW1SQ/HeGjigNdYRs8B5ZSEE=';

  async function submitWg(over: Record<string, unknown>) {
    const sent: Record<string, unknown>[] = [];
    const { result } = renderHook(
      () =>
        useProfileForm({
          profile: null,
          opened: true,
          mode: 'create',
          onSubmit: async (input) => {
            sent.push(input as Record<string, unknown>);
          },
          onClose: () => {},
        }),
      { wrapper },
    );
    act(() =>
      result.current.form.setValues({
        protocol: 'wireguard',
        name: 'wg',
        wgServerPriv: KEY,
        wgServerPub: KEY,
        ...over,
      }),
    );
    await act(async () => {
      await result.current.form.onSubmit(result.current.handleSubmit)();
    });
    return { sent, errors: result.current.form.errors };
  }

  it('новый профиль уходит с подсетью по умолчанию и ключами, без обфускации и поколения', async () => {
    const { sent, errors } = await submitWg({});
    expect(errors).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      protocol: 'wireguard',
      engine: null,
      config: { subnet: '10.77.77.0/24', serverPrivateKey: KEY, serverPublicKey: KEY },
    });
    expect(Object.keys(sent[0]!.config as object).sort()).toEqual(['serverPrivateKey', 'serverPublicKey', 'subnet']);
    expect(sent[0]).not.toHaveProperty('awgProtocol');
  });

  it('подсеть не вида a.b.c.d/n: не отправляется, ошибка у подсети', async () => {
    const { sent, errors } = await submitWg({ wgSubnet: '10.77.77.0' });
    expect(sent).toEqual([]);
    expect(Object.keys(errors)).toEqual(['wgSubnet']);
  });

  it('ключ без «=» на конце: не отправляется, ошибка у ключа', async () => {
    const { sent, errors } = await submitWg({ wgServerPub: 'a'.repeat(44) });
    expect(sent).toEqual([]);
    expect(Object.keys(errors)).toEqual(['wgServerPub']);
  });

  it('правила WireGuard не трогают AmneziaWG, а правила AmneziaWG не трогают WireGuard', async () => {
    const { sent, errors } = await submitWg({ awgServerPriv: '', awgJmin: 500 });
    expect(errors).toEqual({});
    expect(sent).toHaveLength(1);
  });

  it('ключи генерирует та же ручка, что у AmneziaWG: алфавит base64', async () => {
    const { result } = renderHook(
      () => useProfileForm({ profile: null, opened: true, mode: 'create', onSubmit: async () => {}, onClose: () => {} }),
      { wrapper },
    );
    expect(typeof result.current.generateWgKeys).toBe('function');
  });
});
