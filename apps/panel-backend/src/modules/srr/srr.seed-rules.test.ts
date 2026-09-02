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
import { APPS } from '../subscription/formats/client-catalog.js';

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

/**
 * Every rule a fresh deployment ships, in the order the matcher tries them.
 *
 * The by-name reader above answers "what does rule X say"; this one answers
 * "what does a given client GET", which is a different question and the one
 * the catalogue makes claims about. Both INSERT shapes are read: the VALUES
 * list and the `SELECT ... WHERE EXISTS` form the flavour split ships.
 */
function allShippedRules(): { name: string; pattern: string; format: string; priority: number }[] {
  const byName = new Map<string, { name: string; pattern: string; format: string; priority: number }>();
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    const rows = sql.matchAll(
      /(?:\(gen_random_uuid\(\),|SELECT gen_random_uuid\(\),)\s*'([^']+)',\s*([\s\S]*?)(\d+),\s*CURRENT_TIMESTAMP/g,
    );
    for (const r of rows) {
      const quoted = [...(r[2] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
      if (quoted.length < 2) continue;
      byName.set(r[1] as string, {
        name: r[1] as string,
        pattern: quoted[0] as string,
        format: quoted[1] as string,
        priority: Number(r[3]),
      });
    }
    for (const u of sql.matchAll(
      /UPDATE "subscription_response_rules"([\s\S]*?)WHERE "name" = '([^']*)'/g,
    )) {
      const cur = byName.get(u[2] as string);
      if (!cur) continue;
      const pattern = /"ua_pattern" = '([^']*)'/.exec(u[1] as string);
      if (pattern) cur.pattern = pattern[1] as string;
      const format = /"format" = '([^']*)'/.exec(u[1] as string);
      if (format) cur.format = format[1] as string;
    }
  }
  return [...byName.values()].sort((a, b) => a.priority - b.priority);
}

/** What a fresh deployment would actually serve this User-Agent. */
function deliveredFormat(ua: string): { rule: string; format: string } | null {
  for (const rule of allShippedRules()) {
    if (compileRule(rule.pattern).test(ua)) return { rule: rule.name, format: rule.format };
  }
  return null;
}

/**
 * A rule format under the name the catalogue uses for it.
 *
 * One rule format has no `ClientFormat` member, and deliberately:
 * `xrayjson-array` is the SAME xray document split one-profile-per-entry, made
 * for Happ. `usableFormats` asks whether a format renders anything by actually
 * rendering it, and there is nothing separate to render - so the type names
 * four cores, not five serialisations.
 *
 * That equivalence used to live only in a commit message, which is why the
 * mirror below found it as a disagreement the first time it ran. Stated here so
 * there is one place to read it, and so a NEW divergence is still a failure
 * rather than something a reader waves through.
 */
function catalogueName(ruleFormat: string): string {
  return ruleFormat === 'xrayjson-array' ? 'xrayjson' : ruleFormat;
}

// The catalogue says what a client speaks; the rules decide what it is sent.
// They are two independent places and they drift silently - which already cost
// a false statement to buyers on 2026-09-03, when the install card read
// `format` and told Happ users their config carried no routing rules while it
// carried five per profile. Nothing compared the two until this.
describe('the catalogue and the shipped rules agree on what each client gets', () => {
  const checkable = APPS.filter((a) => a.uaSample && a.format);

  it('serves every catalogued client the format the catalogue claims', () => {
    // The control this kind of mirror needs: it asserts over a filtered list,
    // and an empty list would make it pass by checking nothing. Six apps carry
    // a measured User-Agent today; the number may only grow.
    expect(checkable.length).toBeGreaterThanOrEqual(5);

    for (const app of checkable) {
      const got = deliveredFormat(app.uaSample as string);
      expect(got, `${app.name}: no shipped rule matches ${app.uaSample}`).not.toBeNull();
      expect(
        catalogueName(got!.format),
        `${app.name} declares format=${app.format} but rule "${got!.rule}" serves ${got!.format} ` +
          `to ${app.uaSample}`,
      ).toBe(app.format);
    }
  });

  it('sends every tunnel client a wg config, whatever the catalogue says about cards', () => {
    // These apps carry no `format` on purpose - the card has nothing to say
    // about routing for a tunnel - but they DO fetch a format, and sending one
    // a proxy list is the failure that had WG Tunnel complaining about a
    // missing PrivateKey before the rule was split.
    const tunnels = APPS.filter(
      (a) => a.uaSample && (a.action.kind === 'wg-conf' || a.action.kind === 'awg-conf'),
    );
    expect(tunnels.length).toBeGreaterThanOrEqual(1);
    for (const app of tunnels) {
      const got = deliveredFormat(app.uaSample as string);
      expect(got, `${app.name}: nothing matches ${app.uaSample}`).not.toBeNull();
      expect(got!.format, `${app.name} would be served ${got!.format}`).toBe('wgconf');
    }
  });
});

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

  it('seeds Happ onto the format that was built for it', () => {
    // `xrayjson-array` существует ИМЕННО для Happ и V2RayTun: единственный
    // конфиг buildXrayJson они читают как ОДИН сервер, массив — как N. А
    // единственный механизм, ставящий клиента на формат, — правило по
    // User-Agent, потому что `?format=` не шлёт ни один клиент. Значит формат,
    // сделанный для названного клиента, до него не доезжал.
    //
    // Замерено на боевой панели 01.09 на `Happ/4.3.0/Android`: 768 байт, ноль
    // гео-правил, тогда как Hiddify, v2rayNG и Clash свои получили. Пресет
    // маршрутизации, который выставил оператор, до пользователей Happ молча
    // не доходил.
    const happ = shippedRule('Happ');
    expect(happ, 'no seeded Happ rule found in the migrations').not.toBeNull();
    expect(happ!.format).toBe('xrayjson-array');
    expect(compileRule(happ!.pattern).test('Happ/4.3.0/Android')).toBe(true);
    // Control: соседи по той же пачке остались на своих форматах — правка
    // адресная, а не «всем universal-клиентам».
    for (const name of ['Shadowrocket', 'Streisand', 'V2Box']) {
      const r = shippedRule(name);
      expect(r, name).not.toBeNull();
      expect(r!.format, name).toBe('plain');
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
