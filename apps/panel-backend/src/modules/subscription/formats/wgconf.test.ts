import { describe, expect, it } from 'vitest';
import { buildWgQuickConf, wgConfName } from './wgconf.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

const awgEp: SubscriptionEndpoint = {
  protocol: 'amneziawg',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 51820,
  privateKey: 'cliPriv64',
  allowedIp: '10.0.0.42/32',
  serverPublicKey: 'srvPub64',
  jc: 4,
  jmin: 40,
  jmax: 70,
  s1: 72,
  s2: 56,
  s3: 32,
  s4: 16,
  h1: 100,
  h2: 200,
  h3: 300,
  h4: 400,
  uri: '',
};

const wgEp: SubscriptionEndpoint = {
  protocol: 'wireguard',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 51821,
  privateKey: 'cliPriv64',
  allowedIp: '10.77.77.42/32',
  serverPublicKey: 'wgSrvPub64',
  uri: '',
};

const hysteriaEp: SubscriptionEndpoint = {
  protocol: 'hysteria',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 443,
  password: 'hy-secret',
  uri: 'hysteria2://...',
};

describe('buildWgQuickConf', () => {
  it('emits an [Interface]+[Peer] config for an AmneziaWG endpoint', () => {
    const out = buildWgQuickConf([awgEp]);
    expect(out).toContain('[Interface]');
    expect(out).toContain('[Peer]');
    expect(out).toContain('PrivateKey = cliPriv64');
    expect(out).toContain('Address = 10.0.0.42/32');
    expect(out).toContain('PublicKey = srvPub64');
    expect(out).toContain('Endpoint = n1.example.com:51820');
  });

  // Полный туннель без резолвера — это не «настройка по умолчанию», а
  // молчаливый отказ: с AllowedIPs 0.0.0.0/0 клиент остаётся на резолвере своей
  // сети, и домашний 192.168.1.1 уезжает в туннель и умирает там. Проверяем обе
  // ветки, потому что дефолт (строки нет) обязан остаться прежним.
  it('writes DNS into both flavours when the panel sets resolvers', () => {
    const dns = ['1.1.1.1', '1.0.0.1'];
    const awg = buildWgQuickConf([awgEp], undefined, 'amneziawg', { dns });
    const wg = buildWgQuickConf([wgEp], undefined, 'wireguard', { dns });
    expect(awg).toContain('DNS = 1.1.1.1, 1.0.0.1');
    expect(wg).toContain('DNS = 1.1.1.1, 1.0.0.1');
    // Строка принадлежит [Interface], а не [Peer]: wg-quick читает её только там.
    expect(awg.indexOf('DNS =')).toBeLessThan(awg.indexOf('[Peer]'));
    expect(wg.indexOf('DNS =')).toBeLessThan(wg.indexOf('[Peer]'));
  });

  it('omits the DNS line when no resolvers are configured', () => {
    expect(buildWgQuickConf([awgEp])).not.toContain('DNS');
    expect(buildWgQuickConf([wgEp], undefined, 'wireguard', { dns: [] })).not.toContain('DNS');
  });

  // Имя туннеля живёт только в этом комментарии: у wg-quick поля имени нет, а
  // импорт по ссылке в WG Tunnel не читает Content-Disposition и без комментария
  // называет туннель хостом из Endpoint — то есть голым IP.
  it('writes the tunnel name as the FIRST line, before [Interface]', () => {
    for (const [ep, flavour] of [
      [awgEp, 'amneziawg'],
      [wgEp, 'wireguard'],
    ] as const) {
      const out = buildWgQuickConf([ep], undefined, flavour, { name: 'OneginVPN-s2' });
      expect(out.split('\n')[0]).toBe('# Name = OneginVPN-s2');
    }
  });

  it('omits the name comment when no name is given', () => {
    expect(buildWgQuickConf([awgEp]).split('\n')[0]).toBe('[Interface]');
  });
});

describe('wgConfName', () => {
  it('collapses a run of unusable characters instead of one per code unit', () => {
    // Имя ноды несёт эмодзи флага; посимвольная замена давала `_____s2`.
    expect(wgConfName('OneginVPN', '\u{1F1F3}\u{1F1F1} s2', 'wireguard')).toBe('OneginVPN-s2-wg');
    expect(wgConfName('OneginVPN', '\u{1F1F3}\u{1F1F1} s2', 'amneziawg')).toBe('OneginVPN-s2-awg');
  });

  it('falls back when the brand sanitises to nothing, and stays a legal file name', () => {
    expect(wgConfName('\u{1F1F3}\u{1F1F1}')).toBe('subscription');
    expect(wgConfName('OneginVPN')).toBe('OneginVPN');
    expect(wgConfName('a'.repeat(200), 'node').length).toBeLessThanOrEqual(64);
  });

  it('includes the obfuscation parameters from the inbound', () => {
    const out = buildWgQuickConf([awgEp]);
    for (const want of ['Jc = 4', 'S1 = 72', 'S4 = 16', 'H1 = 100', 'H4 = 400']) {
      expect(out).toContain(want);
    }
  });

  it('returns empty string when no AmneziaWG endpoint is present', () => {
    expect(buildWgQuickConf([])).toBe('');
    expect(buildWgQuickConf([hysteriaEp])).toBe('');
  });

  it('skips non-AmneziaWG endpoints, only the first awg endpoint is used', () => {
    const out = buildWgQuickConf([hysteriaEp, awgEp]);
    expect(out).toContain('Address = 10.0.0.42/32');
    expect(out).not.toContain('hy-secret');
  });

  it('emits the first AmneziaWG endpoint when multiple exist and no node is named', () => {
    const second: SubscriptionEndpoint = {
      ...awgEp,
      nodeName: 'us-1',
      host: 'n2.example.com',
      allowedIp: '10.0.0.43/32',
    };
    const out = buildWgQuickConf([awgEp, second]);
    expect(out).toContain('Endpoint = n1.example.com:51820');
    expect(out).not.toContain('n2.example.com');
  });

  // Regression: a user with two AmneziaWG nodes got the FIRST node's config from
  // every per-node link because they all hit bare ?format=wgconf. The per-node
  // link now pins ?node=<nodeName>, which must select that node's tunnel.
  it('selects the AmneziaWG endpoint matching nodeName', () => {
    const second: SubscriptionEndpoint = {
      ...awgEp,
      nodeName: 'us-1',
      host: 'n2.example.com',
      allowedIp: '10.0.0.43/32',
    };
    const out = buildWgQuickConf([awgEp, second], 'us-1');
    expect(out).toContain('Endpoint = n2.example.com:51820');
    expect(out).toContain('Address = 10.0.0.43/32');
    expect(out).not.toContain('n1.example.com');
  });

  it('returns empty when the named node has no AmneziaWG endpoint', () => {
    expect(buildWgQuickConf([awgEp], 'no-such-node')).toBe('');
  });

  it('output is byte-deterministic for the same input', () => {
    expect(buildWgQuickConf([awgEp])).toBe(buildWgQuickConf([awgEp]));
  });

  it('emits a plain config for a wireguard endpoint', () => {
    const out = buildWgQuickConf([wgEp]);
    expect(out).toContain('[Interface]');
    expect(out).toContain('PrivateKey = cliPriv64');
    expect(out).toContain('Address = 10.77.77.42/32');
    expect(out).toContain('PublicKey = wgSrvPub64');
    expect(out).toContain('Endpoint = n1.example.com:51821');
  });

  // The reason plain WireGuard is a separate protocol at all: stock clients
  // abort on the first key they don't know, so a single leaked Jc/S/H line
  // makes the file unusable for exactly the apps this format targets.
  it('emits no AmneziaWG directive for a wireguard endpoint', () => {
    const out = buildWgQuickConf([wgEp]);
    for (const key of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      expect(out).not.toContain(`${key} = `);
    }
  });

  it('serves a wireguard-only subscription without a node hint', () => {
    expect(buildWgQuickConf([hysteriaEp, wgEp])).toContain('Address = 10.77.77.42/32');
  });

  // One node can carry both tunnels (separate interfaces, subnets and ports),
  // so ?node= alone is ambiguous and the flavour has to be pinnable.
  it('picks the flavour when a node serves both', () => {
    const both = [awgEp, wgEp];
    expect(buildWgQuickConf(both, 'eu-1', 'wireguard')).toContain('Address = 10.77.77.42/32');
    expect(buildWgQuickConf(both, 'eu-1', 'amneziawg')).toContain('Address = 10.0.0.42/32');
    expect(buildWgQuickConf(both, 'eu-1', 'amneziawg')).toContain('Jc = 4');
  });

  it('returns empty when the requested flavour is absent', () => {
    expect(buildWgQuickConf([awgEp], undefined, 'wireguard')).toBe('');
    expect(buildWgQuickConf([wgEp], undefined, 'amneziawg')).toBe('');
  });
});

const PSK = 'YmFzZTY0LWtleS0zMi1ieXRlcy1sb25nLWV4YWN0bHk=';

describe('preshared key in the client config', () => {
  // Обе стороны рукопожатия должны совпасть: нода пишет `PresharedKey` пиру
  // ровно при тех же двух условиях, что и этот файл. Разойдутся — клиент не
  // пройдёт рукопожатие, и ни один лог не скажет почему.
  it('пишет ключ, когда он выдан', () => {
    const out = buildWgQuickConf(
      [{ ...wgEp, presharedKey: PSK }],
      undefined,
      'wireguard',
    );
    expect(out).toContain(`PresharedKey = ${PSK}`);
    // В блоке пира, а не интерфейса: ключ относится к соединению с сервером.
    const peerPart = out.slice(out.indexOf('[Peer]'));
    expect(peerPart).toContain('PresharedKey =');
  });

  // Пустая строка — не «ключа нет», а строка, которую wg-quick не разбирает,
  // и iOS-парсер на ней отказывается от файла целиком.
  it('не пишет пустую строку, когда ключа нет', () => {
    for (const psk of [undefined, '']) {
      const out = buildWgQuickConf([{ ...wgEp, presharedKey: psk }], undefined, 'wireguard');
      expect(out).not.toContain('PresharedKey');
    }
  });

  it('то же самое для amneziawg', () => {
    const out = buildWgQuickConf(
      [{ ...awgEp, presharedKey: PSK }],
      undefined,
      'amneziawg',
    );
    expect(out).toContain(`PresharedKey = ${PSK}`);
  });
});
