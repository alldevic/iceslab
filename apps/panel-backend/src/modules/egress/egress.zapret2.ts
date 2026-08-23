import { z } from 'zod';
import {
  DEFAULT_ZAPRET2_PRESET,
  DEFAULT_ZAPRET2_SOCKS_PORT,
  getPresetBody,
  isKnownPreset,
} from './egress.presets.js';

// B2a - the per-node zapret2 desync channel (see egress.presets.ts for the
// architecture). Stored under Node.hardening.zapret2 (a Json blob → no DB
// migration; HardeningSchema is .strict() so the key is declared there too).
// Off-by-default: a node that does not run the channel never receives an
// /applyEgress push and behaves byte-identically to pre-B2a.

export class Zapret2ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Zapret2ConfigError';
  }
}

/**
 * Top-level keys allowed in a zapret2 `config` body. The zapret config file is
 * SHELL-SOURCED by the init scripts, so an attacker-controlled body would be a
 * code-injection vector, so we whitelist keys (and scan for shell metacharacters,
 * see validateZapret2Config) instead of trusting arbitrary text. For B2 the
 * body always comes from a vendored preset, but the validator also guards the
 * raw-edit path F3 will add. Extend this list deliberately when a preset needs
 * a new knob.
 */
export const ALLOWED_ZAPRET2_KEYS: ReadonlySet<string> = new Set([
  'FWTYPE',
  'SET_MAXELEM',
  'IPSET_OPT',
  'IP2NET_OPT4',
  'IP2NET_OPT6',
  'AUTOHOSTLIST_INCOMING_MAXSEQ',
  'AUTOHOSTLIST_RETRANS_MAXSEQ',
  'AUTOHOSTLIST_RETRANS_RESET',
  'AUTOHOSTLIST_RETRANS_THRESHOLD',
  'AUTOHOSTLIST_FAIL_THRESHOLD',
  'AUTOHOSTLIST_FAIL_TIME',
  'AUTOHOSTLIST_UDP_IN',
  'AUTOHOSTLIST_UDP_OUT',
  'AUTOHOSTLIST_DEBUGLOG',
  'MDIG_THREADS',
  'GZIP_LISTS',
  'DESYNC_MARK',
  'DESYNC_MARK_POSTNAT',
  // nfqws (v1) + nfqws2 (v2) strategy blocks.
  'NFQWS_ENABLE',
  'NFQWS_PORTS_TCP',
  'NFQWS_PORTS_UDP',
  'NFQWS_OPT',
  'NFQWS2_ENABLE',
  'NFQWS2_PORTS_TCP',
  'NFQWS2_PORTS_UDP',
  'NFQWS2_TCP_PKT_OUT',
  'NFQWS2_TCP_PKT_IN',
  'NFQWS2_UDP_PKT_OUT',
  'NFQWS2_UDP_PKT_IN',
  'NFQWS2_OPT',
  // tpws (transparent proxy) block, not used by rf-default but a valid zapret mode.
  'TPWS_ENABLE',
  'TPWS_PORTS_TCP',
  'TPWS_OPT',
  'TPPORT',
  'MODE_FILTER',
  'FLOWOFFLOAD',
  'INIT_APPLY_FW',
  'DISABLE_IPV6',
  'FILTER_TTL_EXPIRED_ICMP',
]);

// Shell metacharacters that must never appear in a config body. zapret's own
// config legitimately uses `$VAR` references (e.g. `$SET_MAXELEM`), so a bare
// `$` is allowed, but command substitution `$(...)`, backticks, statement
// separators, pipes, background `&` and redirections are not.
const SHELL_INJECTION = /[`;|&<>]|\$\(/;

function countDoubleQuotes(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === '"') n++;
  return n;
}

/**
 * Returns the top-level `KEY=` assignments in a zapret2 config body, tracking
 * multi-line double-quoted values (NFQWS2_OPT spans several lines) so the keys
 * inside the quoted value aren't mistaken for assignments. Throws on a
 * non-assignment top-level line or an unterminated quote.
 */
export function topLevelKeys(body: string): string[] {
  const out: string[] = [];
  const lines = body.split('\n');
  let inQuote = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inQuote) {
      if (countDoubleQuotes(lines[i]) % 2 === 1) inQuote = false;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (!m) {
      throw new Zapret2ConfigError(
        `line ${i + 1}: not a KEY=VALUE assignment: "${trimmed.slice(0, 40)}"`,
      );
    }
    out.push(m[1]);
    if (countDoubleQuotes(trimmed.slice(m[0].length)) % 2 === 1) inQuote = true;
  }
  if (inQuote) throw new Zapret2ConfigError('unterminated quoted value');
  return out;
}

/**
 * Validate a zapret2 config body: no shell metacharacters, every top-level key
 * whitelisted. Throws Zapret2ConfigError on the first violation. Pure.
 */
export function validateZapret2Config(body: string): void {
  if (SHELL_INJECTION.test(body)) {
    throw new Zapret2ConfigError('config contains forbidden shell metacharacters');
  }
  for (const key of topLevelKeys(body)) {
    if (!ALLOWED_ZAPRET2_KEYS.has(key)) {
      throw new Zapret2ConfigError(`unknown zapret2 config key: ${key}`);
    }
  }
}

/**
 * Per-node egress policy. `preset` selects a vendored config body; the optional
 * structured fields override common knobs (resolved into the body by
 * resolveZapret2Config). `.strict()` so a typo fails loud, as HardeningSchema is
 * .strict() too.
 */
export const Zapret2ConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    preset: z
      .string()
      .min(1)
      .max(64)
      .default(DEFAULT_ZAPRET2_PRESET)
      .refine(isKnownPreset, { message: 'unknown zapret2 preset' }),
    /** Override NFQWS2_PORTS_TCP, e.g. "80,443". */
    portsTcp: z.string().regex(/^\d{1,5}(,\d{1,5})*$/).max(128).optional(),
    /** Override NFQWS2_PORTS_UDP, e.g. "443". */
    portsUdp: z.string().regex(/^\d{1,5}(,\d{1,5})*$/).max(128).optional(),
    /**
     * Where the stack's SOCKS frontend listens on the node (ss-zapret2's
     * SOCKS_PORT, the ansible role's iceslab_zapret2_socks_port). This is what
     * makes zapret2 reachable as an egress CHANNEL: the B1 policy compiles a
     * rule targeting zapret2 into a socks outbound pointed here, and the desync
     * happens on that proxy's own egress (nfqws runs in its netns).
     */
    socksPort: z.number().int().min(1).max(65535).default(DEFAULT_ZAPRET2_SOCKS_PORT),
  })
  .strict();
export type Zapret2ConfigInput = z.infer<typeof Zapret2ConfigSchema>;

function replaceAssignment(body: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (!re.test(body)) {
    throw new Zapret2ConfigError(`preset has no ${key} line to override`);
  }
  return body.replace(re, `${key}=${value}`);
}

/**
 * Resolve a stored egress policy into the wire form pushed to the node:
 * `{ enabled, config }` where `config` is the final zapret2 config body (preset
 * + structured overrides applied). Validates the result before returning.
 */
export function resolveZapret2Config(policy: Zapret2ConfigInput): {
  enabled: boolean;
  config: string;
} {
  const base = getPresetBody(policy.preset);
  if (base === undefined) {
    throw new Zapret2ConfigError(`unknown preset: ${policy.preset}`);
  }
  let body = base;
  if (policy.portsTcp !== undefined) {
    body = replaceAssignment(body, 'NFQWS2_PORTS_TCP', policy.portsTcp);
  }
  if (policy.portsUdp !== undefined) {
    body = replaceAssignment(body, 'NFQWS2_PORTS_UDP', policy.portsUdp);
  }
  validateZapret2Config(body);
  return { enabled: policy.enabled, config: body };
}

/**
 * The port a rule targeting zapret2 should be sent to on this node, or null
 * when the node does not run the channel: never provisioned, stored config
 * drifted out of shape, or the operator switched it off. Switched off matters
 * as much as absent - the stack is torn down by /applyEgress, so a rule
 * pointing into its SOCKS port would black-hole the traffic it names.
 */
export function zapret2SocksPortFor(raw: unknown): number | null {
  if (raw == null) return null;
  const parsed = Zapret2ConfigSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.enabled) return null;
  return parsed.data.socksPort;
}
