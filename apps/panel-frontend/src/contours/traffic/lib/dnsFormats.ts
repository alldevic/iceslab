import type { DnsServerKind } from '@iceslab/shared';

/**
 * Which subscription formats run a "names -> DNS server" rule (stage 19). A
 * constant table, not an answer of the server: it is written from PLAN-dns.md
 * section 2 and the measurements of m19-01 (xray 26.3.27 and sing-box 1.13.14
 * as cores; no client app, no mihomo binary was run). Every format that runs a
 * rule has its builder now (m19.4 xray, xkeen; m19.5 mihomo; m19.6 sing-box). When a builder changes,
 * this is edited by hand, and nothing compares the two.
 *
 *   runs   yes: the builder writes the rule; no: it does not, and says nothing in the file.
 *   kinds  the server kinds measured to work; 'unverified' where nothing was run;
 *          null where the format does not run rules at all.
 */
export type DnsFormatNote = 'xray' | 'xrayApps' | 'xkeen' | 'mihomo' | 'noGroup' | 'wg' | 'noSection';

export interface DnsFormatRow {
  id: string;
  /** Shown as written: a format name is the same in both languages. */
  label: string;
  runs: boolean;
  kinds: readonly DnsServerKind[] | 'unverified' | null;
  note: DnsFormatNote | null;
}

const XRAY_MEASURED: readonly DnsServerKind[] = ['udp', 'tcp', 'https'];

export const DNS_FORMATS: readonly DnsFormatRow[] = [
  { id: 'xray-json', label: 'xray-json', runs: true, kinds: XRAY_MEASURED, note: 'xray' },
  { id: 'xray-array', label: 'xray-json (array)', runs: true, kinds: XRAY_MEASURED, note: 'xrayApps' },
  { id: 'xkeen', label: 'xkeen', runs: true, kinds: 'unverified', note: 'xkeen' },
  { id: 'mihomo', label: 'mihomo', runs: true, kinds: 'unverified', note: 'mihomo' },
  { id: 'sing-box', label: 'sing-box', runs: true, kinds: ['udp', 'tcp', 'tls', 'https'], note: null },
  { id: 'stash', label: 'Stash', runs: false, kinds: null, note: 'noGroup' },
  { id: 'clash', label: 'Clash', runs: false, kinds: null, note: 'noGroup' },
  { id: 'wireguard', label: 'WireGuard', runs: false, kinds: null, note: 'wg' },
  { id: 'amneziawg', label: 'AmneziaWG', runs: false, kinds: null, note: 'wg' },
  { id: 'links', label: 'URI list', runs: false, kinds: null, note: 'noSection' },
  { id: 'surge', label: 'Surge', runs: false, kinds: null, note: 'noSection' },
  { id: 'loon', label: 'Loon', runs: false, kinds: null, note: 'noSection' },
  { id: 'quantumultx', label: 'Quantumult X', runs: false, kinds: null, note: 'noSection' },
  { id: 'outline', label: 'Outline', runs: false, kinds: null, note: 'noSection' },
];
