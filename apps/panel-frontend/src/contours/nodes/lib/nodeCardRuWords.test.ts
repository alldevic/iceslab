import { describe, expect, it } from 'vitest';
import ru from '@/i18n/locales/ru';

/**
 * The node card in Russian speaks Russian: a Latin word in its strings is
 * either on this list (protocol, core and unit names, codes the agent or the
 * server sends, terms the panel keeps as they are) or a label nobody
 * translated, like the «Disk» and «1 bindings» it used to print.
 */
const ALLOWED = new Set([
  'mTLS', 'xray', 'bootstrap', 'degraded', 'not-applicable', 'RSS', 'OOM', 'GeoIP',
  'IP', 'DNS', 'SSH', 'AWG', 'AmneziaWG', 'sing-box', 'hysteria', 'x', 'MiB', 'ms',
]);

function latinWords(node: unknown, out: Map<string, string>, path: string): void {
  if (typeof node === 'string') {
    const text = node.replace(/\{\{[^}]*\}\}/g, '');
    for (const w of text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []) out.set(w, path);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) latinWords(v, out, path ? `${path}.${k}` : k);
  }
}

describe('карточка ноды в ru без английских подписей', () => {
  it('латиница в nodeCard только из разрешённого списка', () => {
    const words = new Map<string, string>();
    latinWords((ru as Record<string, unknown>).nodeCard, words, 'nodeCard');
    // The walk found the card at all (mTLS, xray are there by design).
    expect(words.has('mTLS')).toBe(true);
    const stray = [...words].filter(([w]) => !ALLOWED.has(w)).map(([w, at]) => `${w} (${at})`);
    expect(stray).toEqual([]);
  });
  it('«Диск» и привязки по-русски', () => {
    const card = (ru as { nodeCard: Record<string, unknown> }).nodeCard;
    expect(card.disk).toBe('Диск');
    expect(card.reBootstrap).toBe('Перевыпустить bootstrap');
  });
});
