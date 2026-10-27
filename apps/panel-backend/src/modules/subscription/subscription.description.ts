/**
 * A-236 step 6: a host's description in a share link, the way Happ reads it
 * (happ.su dev-docs/app-management, read 24.10):
 *   - vless, trojan, ss, socks, wireguard: after the title,
 *     `<link>#title?serverDescription=<base64 of UTF-8>`;
 *   - vmess: the link is base64 of a JSON object, the description is a field
 *     of that object, as text.
 * Other schemes (hy2, tuic, tg, ...) are not in Happ's list and keep their
 * link as it is. A link without a title has nowhere to put it either.
 */

const AFTER_TITLE = /^(vless|trojan|ss|socks|socks5|wireguard):\/\//;

export function linkWithDescription(uri: string, description: string): string {
  if (uri.startsWith('vmess://')) {
    try {
      const obj = JSON.parse(Buffer.from(uri.slice('vmess://'.length), 'base64').toString('utf-8')) as Record<string, unknown>;
      obj.serverDescription = description;
      return `vmess://${Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')}`;
    } catch {
      return uri;
    }
  }
  if (!AFTER_TITLE.test(uri) || !uri.includes('#')) return uri;
  return `${uri}?serverDescription=${Buffer.from(description, 'utf-8').toString('base64')}`;
}
