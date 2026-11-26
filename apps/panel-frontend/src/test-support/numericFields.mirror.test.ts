import { describe, expect, it } from 'vitest';
import { MIERU_MTU } from '@/contours/profiles/lib/mieruMtu';
import { backendSource, outsideFrontendFilter } from '@/test-support/backendSource';
import { stripComments } from '@/test-support/declarations';

/**
 * Every numeric control the panel renders, against the rule the API validates
 * it with (milestone 17.2).
 *
 * The operator types a value the control accepted, presses save, and the API
 * refuses it. Two shapes of that: the API says `.int()` and the input takes
 * decimals; the input's range is wider than the API's (a stepper that reaches 0
 * where the schema says 64, no `max` where the schema caps).
 *
 * The rule is one-directional on purpose. A control may be STRICTER than the
 * API (H1..H4 stop at 2^31-1 where the schema takes 2^32-1), but it may never
 * offer what the API refuses.
 *
 * Both sides are read from source as text. The table is the mapping (which
 * control answers to which schema field) and nothing else: no bound is written
 * down twice.
 */

const CONTROLS = import.meta.glob(['/src/**/*.tsx', '!/src/**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The source of a control file, by its path under src/. */
function controlFile(path: string): string {
  const src = CONTROLS[`/src/${path}`];
  if (src === undefined) throw new Error(`/src/${path} is gone (or is a test): fix the table`);
  return src;
}

interface Site {
  /** Frontend file, relative to src/. */
  form: string;
  /** Substring that identifies the NumberInput: its form binding or its `value=`. */
  anchor: string;
  /** Backend file, relative to panel-backend/src/modules/. */
  schema: string;
  /** The field name in that schema. */
  field: string;
}

/** A NumberInput held to no schema, with the reason. */
interface Unbound {
  form: string;
  anchor: string;
  reason: string;
}

const INBOUNDS = 'inbounds/inbounds.schemas.ts';
const PROFILE_FORM = 'contours/profiles/components/ProfileForm';
const HOSTS = 'hosts/hosts.schemas.ts';

const SITES: Site[] = [
  // Hysteria 2
  { form: `${PROFILE_FORM}/HysteriaSection.tsx`, anchor: "getInputProps('hyBrutalUp')", schema: INBOUNDS, field: 'brutalUpMbps' },
  { form: `${PROFILE_FORM}/HysteriaSection.tsx`, anchor: "getInputProps('hyBrutalDown')", schema: INBOUNDS, field: 'brutalDownMbps' },
  { form: `${PROFILE_FORM}/HysteriaSection.tsx`, anchor: "getInputProps('hyPortHopStart')", schema: INBOUNDS, field: 'portHoppingStart' },
  { form: `${PROFILE_FORM}/HysteriaSection.tsx`, anchor: "getInputProps('hyPortHopEnd')", schema: INBOUNDS, field: 'portHoppingEnd' },
  // Xray REALITY tuning
  { form: `${PROFILE_FORM}/XrayAdvanced.tsx`, anchor: "getInputProps('xrayRealityMaxTimeDiff')", schema: INBOUNDS, field: 'realityMaxTimeDiff' },
  { form: `${PROFILE_FORM}/XrayAdvanced.tsx`, anchor: "getInputProps('xrayRealityLimitFallbackUpload')", schema: INBOUNDS, field: 'realityLimitFallbackUploadBytesPerSec' },
  { form: `${PROFILE_FORM}/XrayAdvanced.tsx`, anchor: "getInputProps('xrayRealityLimitFallbackDownload')", schema: INBOUNDS, field: 'realityLimitFallbackDownloadBytesPerSec' },
  // AmneziaWG obfuscation
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgJc')", schema: INBOUNDS, field: 'jc' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgJmin')", schema: INBOUNDS, field: 'jmin' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgJmax')", schema: INBOUNDS, field: 'jmax' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgS1')", schema: INBOUNDS, field: 's1' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgS2')", schema: INBOUNDS, field: 's2' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgS3')", schema: INBOUNDS, field: 's3' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgS4')", schema: INBOUNDS, field: 's4' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgH1')", schema: INBOUNDS, field: 'h1' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgH2')", schema: INBOUNDS, field: 'h2' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgH3')", schema: INBOUNDS, field: 'h3' },
  { form: `${PROFILE_FORM}/AmneziawgSection.tsx`, anchor: "getInputProps('awgH4')", schema: INBOUNDS, field: 'h4' },
  // Mieru
  { form: `${PROFILE_FORM}/MieruSection.tsx`, anchor: "getInputProps('mieruMtu')", schema: INBOUNDS, field: 'mtu' },
  // Ports that are their own field
  { form: 'contours/profiles/components/DeployProfileModal.tsx', anchor: 'value={port}', schema: 'profiles/profiles.schemas.ts', field: 'port' },
  { form: 'contours/hosts/screens/HostEditPage.tsx', anchor: 'value={port}', schema: HOSTS, field: 'port' },
  { form: 'contours/hosts/screens/HostEditPage.tsx', anchor: 'value={clientPort}', schema: HOSTS, field: 'portOverride' },
  { form: 'contours/traffic/screens/NamedOutboundsPage.tsx', anchor: 'value={v.port}', schema: 'named-outbounds/named-outbounds.schemas.ts', field: 'port' },
  // Node capacity, user and squad limits
  { form: 'contours/nodes/components/NodeEdit/NodeParamsForm.tsx', anchor: "getInputProps('maxUsers')", schema: 'nodes/nodes.schemas.ts', field: 'maxUsers' },
  { form: 'contours/users/components/UserDrawer/AdvancedPanel.tsx', anchor: "getInputProps('hwidDeviceLimit')", schema: 'users/users.schemas.ts', field: 'hwidDeviceLimit' },
  { form: 'contours/squads/screens/SquadEditPage.tsx', anchor: 'value={hwidLimit}', schema: 'squads/squads.schemas.ts', field: 'hwidDeviceLimit' },
  // Routing, subscription, geo
  { form: 'contours/subscription/screens/SrrRulePage.tsx', anchor: 'value={draft.priority}', schema: 'srr/srr.schemas.ts', field: 'priority' },
  { form: 'contours/subscription/screens/SubscriptionMetadataPage.tsx', anchor: 'value={draft.intervalHours}', schema: 'settings/settings.schemas.ts', field: 'subscriptionUpdateIntervalHours' },
  { form: 'contours/subscription/screens/SubscriptionMetadataPage.tsx', anchor: 'value={draft.entryPoolSize}', schema: 'settings/settings.schemas.ts', field: 'subscriptionEntryPoolSize' },
  { form: 'contours/traffic/screens/GeoSetsPage.tsx', anchor: 'value={hours}', schema: 'geo-sets/geo-sets.routes.ts', field: 'refreshHours' },
];

const UNBOUND: Unbound[] = [
  {
    form: 'contours/nodes/components/NodeEdit/NodeParamsForm.tsx',
    anchor: "getInputProps('port')",
    reason: 'the node port is folded into `address` (host:port) and validated by its regex, not by a numeric field',
  },
  {
    form: 'contours/nodes/components/NodeCreate/StepParams.tsx',
    anchor: "getInputProps('port')",
    reason: 'the node port is folded into `address` (host:port) and validated by its regex, not by a numeric field',
  },
  {
    form: 'contours/profiles/components/RecipeExportModal.tsx',
    anchor: 'value={dpi}',
    reason: 'a 1..5 rating written into the exported recipe file; no API request carries it',
  },
  {
    form: 'contours/profiles/components/RecipeExportModal.tsx',
    anchor: 'value={speed}',
    reason: 'a 1..5 rating written into the exported recipe file; no API request carries it',
  },
];

/** `<NumberInput ... />` tags of one file: their props text, up to the tag's own close. Throws on an unterminated tag. */
function numberInputs(src: string, where: string): string[] {
  const clean = stripComments(src);
  const out: string[] = [];
  for (let at = clean.indexOf('<NumberInput'); at >= 0; at = clean.indexOf('<NumberInput', at + 1)) {
    let depth = 0;
    let end = -1;
    for (let i = at; i < clean.length; i += 1) {
      const ch = clean[i]!;
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (depth === 0 && ch === '/' && clean[i + 1] === '>') {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error(`unterminated <NumberInput in ${where}`);
    out.push(clean.slice(at, end));
  }
  return out;
}

/** The props of the one NumberInput that carries `anchor`; throws when there is none or several. */
function inputProps(path: string, anchor: string): string {
  const hits = numberInputs(controlFile(path), path).filter((p) => p.includes(anchor));
  if (hits.length !== 1) throw new Error(`${hits.length} NumberInputs carry "${anchor}" in ${path}, expected 1`);
  return hits[0]!;
}

const SYMBOLS: Record<string, number> = { 'MIERU_MTU.min': MIERU_MTU.min, 'MIERU_MTU.max': MIERU_MTU.max };

/** `min={5}` or `min={SYMBOL}` of the props as a number, null when absent. */
function num(props: string, prop: string): number | null {
  const m = new RegExp(`\\b${prop}=\\{([^}]+)\\}`).exec(props);
  if (!m) return null;
  const raw = m[1]!.trim();
  const v = raw in SYMBOLS ? SYMBOLS[raw]! : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`cannot read ${prop}={${raw}}`);
  return v;
}

interface Rule {
  int: boolean;
  min: number | null;
  max: number | null;
  decls: string[];
}

/** The expression of the declaration starting at `from`: up to the `,` or `;` at depth 0, or the closing brace. */
function expressionAt(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return src.slice(from, i).trim();
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === ';')) return src.slice(from, i).trim();
  }
  throw new Error('unterminated declaration');
}

/**
 * The zod rule for one field, as the API enforces it.
 *
 * A field can be declared more than once in a schema file (create and update
 * shapes), and the control has to satisfy whichever endpoint it posts to, so
 * the bounds are intersected: the highest floor and the lowest ceiling. A rule
 * given a name (`port: PortSchema`) is resolved through the `const` beside it.
 * Throws when no declaration is found: an unrecognised shape must fail, not be
 * skipped.
 */
function zodRule(file: string, field: string): Rule {
  const src = stripComments(backendSource(file));
  const decls: string[] = [];
  for (const m of src.matchAll(new RegExp(`^\\s*${field}:\\s*`, 'gm'))) {
    let expr = expressionAt(src, m.index! + m[0].length);
    if (!expr.startsWith('z.')) {
      const name = /^([A-Za-z_$][\w$]*)/.exec(expr)?.[1];
      const decl = name ? new RegExp(`^(?:export )?const ${name} = `, 'm').exec(src) : null;
      if (!name || !decl) continue; // a TypeScript member of the same name, not a rule
      expr = expressionAt(src, decl.index + decl[0].length) + expr.slice(name.length);
    }
    decls.push(expr.replace(/\s+/g, ''));
  }
  if (decls.length === 0) throw new Error(`no zod rule for ${field} in ${file}`);

  let min: number | null = null;
  let max: number | null = null;
  let int = true;
  for (const d of decls) {
    if (!d.includes('.int()')) int = false;
    const floor = d.includes('.positive()')
      ? 1
      : d.includes('.nonnegative()')
        ? 0
        : Number(/\.min\((-?[\d_]+)\)/.exec(d)?.[1] ?? NaN);
    if (Number.isFinite(floor)) min = min === null ? floor : Math.max(min, floor);
    const ceil = Number(/\.max\((-?[\d_]+)\)/.exec(d)?.[1] ?? NaN);
    if (Number.isFinite(ceil)) max = max === null ? ceil : Math.min(max, ceil);
  }
  return { int, min, max, decls };
}

const label = (s: Site) => `${s.form.split('/').pop()} ${s.field}`;
const rows = SITES.map((s) => [label(s), s] as const);

describe('every numeric control offers only what its API accepts', () => {
  it.each(rows)('%s takes only whole numbers when the API says .int()', (_l, s) => {
    const rule = zodRule(s.schema, s.field);
    if (!rule.int) return;
    expect(inputProps(s.form, s.anchor), `${s.field} is .int() in ${s.schema}: ${rule.decls[0]}`).toContain(
      'allowDecimal={false}',
    );
  });

  it.each(rows)('%s starts no lower than the API floor', (_l, s) => {
    const rule = zodRule(s.schema, s.field);
    if (rule.min === null) return;
    const min = num(inputProps(s.form, s.anchor), 'min');
    expect(min, `no min= on ${s.field} in ${s.form}; the API refuses below ${rule.min}`).not.toBeNull();
    expect(min!, `the stepper reaches ${min}, the API refuses below ${rule.min}`).toBeGreaterThanOrEqual(rule.min);
  });

  it.each(rows)('%s stops no higher than the API ceiling', (_l, s) => {
    const rule = zodRule(s.schema, s.field);
    if (rule.max === null) return;
    const max = num(inputProps(s.form, s.anchor), 'max');
    expect(max, `${s.field} has no max= but the API caps it at ${rule.max}`).not.toBeNull();
    expect(max!, `the control offers ${max}, the API caps at ${rule.max}`).toBeLessThanOrEqual(rule.max);
  });
});

describe('the table covers every NumberInput of the panel', () => {
  it('each NumberInput in src/ is in the table or named as held to no schema', () => {
    const known = [...SITES, ...UNBOUND];
    const stray: string[] = [];
    let total = 0;
    for (const [path, src] of Object.entries(CONTROLS)) {
      for (const props of numberInputs(src, path)) {
        total += 1;
        const hits = known.filter((k) => path === `/src/${k.form}` && props.includes(k.anchor));
        if (hits.length !== 1) stray.push(`${path}: ${hits.length} entries for ${props.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }
    expect(total, 'the scan found no NumberInput at all').toBeGreaterThan(20);
    expect(stray, 'add the control to SITES (with its schema field) or to UNBOUND (with the reason)').toEqual([]);
  });

  it('every entry still points at a NumberInput', () => {
    for (const k of [...SITES, ...UNBOUND]) expect(inputProps(k.form, k.anchor)).toContain('<NumberInput');
    expect(SITES.length + UNBOUND.length).toBe(
      Object.entries(CONTROLS).reduce((n, [p, src]) => n + numberInputs(src, p).length, 0),
    );
  });

  it('the schema files start the frontend CI job when edited', () => {
    expect(
      outsideFrontendFilter([...new Set(SITES.map((s) => s.schema))]),
      'add the file to the `frontend` filter of the `changes` job in .github/workflows/ci.yml',
    ).toEqual([]);
  });

  it('the parsers answer about something, on both sides', () => {
    const jmin = zodRule(INBOUNDS, 'jmin');
    expect([jmin.int, jmin.min, jmin.max]).toEqual([true, 64, 1024]);
    const port = zodRule('profiles/profiles.schemas.ts', 'port');
    expect([port.int, port.min, port.max]).toEqual([true, 1, 65535]);
    const props = inputProps(`${PROFILE_FORM}/AmneziawgSection.tsx`, "getInputProps('awgJmin')");
    expect(num(props, 'min')).toBe(64);
    expect(props).toContain('allowDecimal={false}');
    // MIERU_MTU is a symbol, not a literal: it must resolve through SYMBOLS
    expect(num(inputProps(`${PROFILE_FORM}/MieruSection.tsx`, "getInputProps('mieruMtu')"), 'min')).toBe(MIERU_MTU.min);
  });
});
