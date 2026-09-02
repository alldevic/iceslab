// The User-Agent rules a FRESH deployment gets, read from the migrations that
// ship them.
//
// Not from the database on purpose. `cleanDatabase()` truncates the table, so a
// test that seeded its own rows would be checking its own fixture; and the lab
// databases have had the seed wiped, which is exactly the state in which nobody
// would notice the rules being wrong. What ships is the SQL, so that is what is
// read here and compiled with the real compiler.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileRule } from './srr.service.js';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');

/** A rule as a fresh deployment ends up holding it: the seeded INSERT, with any
 *  later UPDATE of the same rule applied in migration order. Null when no
 *  migration ships a rule by that name — which is a different fact from "ships
 *  it empty", and the tests below tell the two apart. */
interface ShippedRule {
  pattern: string;
  format: string;
  proto: string | null;
}

function shippedRule(ruleName: string): ShippedRule | null {
  let rule: ShippedRule | null = null;
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    // A seeded row, read as the run of quoted values between the rule's name
    // and the CURRENT_TIMESTAMP that ends it: pattern, format, and — since the
    // flavour column exists — the wg flavour. Reading positionally rather than
    // by column name because the two seed batches and the flavour split write
    // the row three different ways, and only the ORDER is common to all three.
    const inserted = new RegExp(`'${ruleName}',\\s*([\\s\\S]*?)CURRENT_TIMESTAMP`).exec(sql);
    if (inserted) {
      const quoted = [...(inserted[1] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
      rule = {
        pattern: quoted[0] ?? '',
        format: quoted[1] ?? '',
        proto: quoted[2] ?? null,
      };
    }
    // Every UPDATE in the file, in order — one migration may re-point several
    // rules, and taking only the first silently reports the others unchanged.
    const updates = sql.matchAll(
      /UPDATE "subscription_response_rules"([\s\S]*?)WHERE "name" = '([^']*)'/g,
    );
    for (const u of updates) {
      if (u[2] !== ruleName || !rule) continue;
      const set = u[1] as string;
      const pattern = /"ua_pattern" = '([^']*)'/.exec(set);
      if (pattern) rule.pattern = pattern[1] as string;
      const format = /"format" = '([^']*)'/.exec(set);
      if (format) rule.format = format[1] as string;
      const proto = /"proto" = '([^']*)'/.exec(set);
      if (proto) rule.proto = proto[1] as string;
    }
  }
  return rule;
}

/** Kept because most cases only care about the pattern. */
function shippedPattern(ruleName: string): string {
  return shippedRule(ruleName)?.pattern ?? '';
}

describe('seeded User-Agent rules', () => {
  it('routes the Clash-family clients it names, whatever the casing', () => {
    const pattern = shippedPattern('Clash');
    expect(pattern, 'no seeded Clash rule found in the migrations').not.toBe('');
    const re = compileRule(pattern);

    // `stash` is in the pattern in lower case, which is only explicable as an
    // attempt to catch this client. Before 20260826000000 the rule was compiled
    // case-sensitively and could not.
    expect(re.test('Stash/2.9.0'), 'Stash falls through to the plain catch-all').toBe(true);
    // Clash Verge ships its name lower-cased in the UA.
    expect(re.test('clash-verge/2.0.3')).toBe(true);
    // And everything that already worked keeps working.
    for (const ua of ['FlClash/0.8.80', 'ClashX/1.118.0', 'mihomo/1.18', 'ClashMetaForAndroid/2.11'])
      expect(re.test(ua), ua).toBe(true);
    // Still narrow: an unrelated client must not be dragged into `clash`.
    expect(re.test('Happ/1.0')).toBe(false);
    expect(re.test('v2rayNG/1.8.0')).toBe(false);
  });

  it('sends each wg client the flavour its own tools accept', () => {
    // Формат — половина ответа. `wgconf` рисует два несовместимых файла, и
    // стоковый wireguard-tools на конфиг AmneziaWG отвечает
    // `Line unrecognized: 'Jc = 4'`, после чего wg-quick сносит интерфейс.
    // Пока правило умело называть только формат, подбор брал ПЕРВЫЙ wg-
    // эндпоинт: замерено на боевой панели 03.09 — стоковый клиент получал
    // AmneziaWG на порту 1234 и отвергал файл.
    const amnezia = shippedRule('AmneziaWG-app');
    const wireguard = shippedRule('WireGuard');
    // Control: both rules are shipped at all. A reader that finds nothing
    // would otherwise pass every assertion below by having nothing to check.
    expect(amnezia, 'no seeded AmneziaWG rule found in the migrations').not.toBeNull();
    expect(wireguard, 'no seeded WireGuard rule found in the migrations').not.toBeNull();

    expect(amnezia!.format).toBe('wgconf');
    expect(amnezia!.proto).toBe('amneziawg');
    expect(wireguard!.format).toBe('wgconf');
    expect(wireguard!.proto).toBe('wireguard');

    const amneziaRe = compileRule(amnezia!.pattern);
    const wireguardRe = compileRule(wireguard!.pattern);

    // Каждый клиент попадает в своё правило и НЕ попадает в чужое: одно
    // правило на оба флейвора — это ровно тот дефект, который здесь закрыт.
    for (const ua of ['WireGuard/1.0.16 (Android)', 'wireguard-cli', 'WireSock/1.2.41']) {
      expect(wireguardRe.test(ua), ua).toBe(true);
      expect(amneziaRe.test(ua), `${ua} must not be read as Amnezia`).toBe(false);
    }
    for (const ua of ['AmneziaVPN/4.8.2.0', 'AmneziaWG/1.0', 'amneziawg-android']) {
      expect(amneziaRe.test(ua), ua).toBe(true);
      expect(wireguardRe.test(ua), `${ua} must not be read as stock WireGuard`).toBe(false);
    }
    // WG Tunnel matched NO seeded rule at all and fell through to the `.*`
    // catch-all, so it got a base64 URI list — about which its complaint is
    // "no PrivateKey", i.e. it names the config and not the format.
    for (const ua of ['wgtunnel/3.7.1', 'wg-tunnel/2.0'])
      expect(wireguardRe.test(ua), ua).toBe(true);

    // And the flavour is where the wg file is rendered, nowhere else: a rule
    // carrying one on another format would be a setting that does nothing.
    for (const name of ['Hiddify', 'Clash', 'v2rayN', 'Happ', 'Default']) {
      const r = shippedRule(name);
      expect(r, `no seeded ${name} rule found`).not.toBeNull();
      expect(r!.proto, name).toBeNull();
    }
  });

  it('gives every seeded rule the case-insensitive flag its neighbours have', () => {
    // The whole 20260617020000 batch carries `(?i)` and says why: a client that
    // misses its rule "fell through to the `.*` -> plain catch-all and got a
    // base64 list they can't import". A rule without it is that bug waiting.
    const named = ['Hiddify', 'NekoBox/NekoRay', 'sing-box', 'Clash', 'v2rayN'];
    const missing = named.filter((n) => !shippedPattern(n).startsWith('(?i)'));
    expect(missing).toEqual([]);
  });
});
