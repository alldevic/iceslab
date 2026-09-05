/**
 * Prints the install document as a BUYER reads it: every platform, every app,
 * every step, in Russian, with the "recommended" badge shown where it survives.
 *
 * Why a script and not a test. The tests hold single claims — this block comes
 * before that one, this card names that channel — and every one of them can
 * pass while the page as a whole tells a buyer something false. The first
 * version of the App Store notice passed its tests and named sing-box as the
 * client the Russian store does sell; sing-box is the one app on that tab with
 * no listing in any store at all. Nothing but reading the rendered text end to
 * end would have caught it, and it is the text we ship.
 *
 * Fixtures rather than the live panel on purpose: it needs no database, no
 * token and no network, so it can be run while writing the copy. The protocol
 * list below is the `main` squad as deployed on 2026-09-05 — widen it if the
 * fleet gains a channel.
 *
 *   npx tsx scripts/print-subpage-config.ts [en]
 */
import { buildSubpageConfig } from '../src/modules/remnawave-compat/subpage/subpage-config.js';

const lang = process.argv[2] === 'en' ? 'en' : 'ru';

const doc = buildSubpageConfig({
  subUrl: 'https://panel.example/sub/TOKEN',
  protocols: [
    'xray',
    'tuic',
    'hysteria',
    'anytls',
    'shadowtls',
    'wireguard',
    'amneziawg',
    'mtproto',
  ],
  awgNodes: [
    { nodeName: 'Онегин 1', deviceIndex: 1, vpnKey: 'vpn://KEY1' },
    { nodeName: 'Онегин 1', deviceIndex: 2, vpnKey: 'vpn://KEY2' },
  ],
  wgNodes: [
    { nodeName: 'Онегин 1', deviceIndex: 1 },
    { nodeName: 'Онегин 1', deviceIndex: 2 },
  ],
  mtprotoNodes: [{ nodeName: 'Онегин 1', tmeUri: 'https://t.me/proxy?server=s&port=2083&secret=ee' }],
  branding: { title: 'OneginVPN', logoUrl: 'https://panel.example/logo.png', supportUrl: 'https://t.me/support' },
});

if (!doc) {
  console.log('no document for this input — the shop would render its own guide');
  process.exit(0);
}

for (const [platformKey, platform] of Object.entries(doc.platforms)) {
  console.log(`\n${'='.repeat(60)}\n${platform.displayName} (${platformKey})`);
  for (const app of platform.apps) {
    console.log(`\n  ${app.name}${app.featured ? '   [recommended]' : ''}`);
    for (const block of app.blocks) {
      console.log(`    - ${block.title[lang]}`);
      console.log(`      ${block.description[lang]}`);
      if (block.buttons.length > 0) {
        console.log(`      buttons: ${block.buttons.map((b) => b.text[lang]).join(' | ')}`);
      }
    }
  }
}
