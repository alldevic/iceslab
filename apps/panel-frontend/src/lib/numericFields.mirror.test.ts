import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every numeric control the panel renders, against the rule the API validates
 * it with.
 *
 * `nodeMultiplier.mirror.test.ts` asked this question about ONE field, because
 * one field was where it had been noticed: four node forms offered fractional
 * multipliers for a column that is `z.number().int().positive()`. The slice was
 * never run across the rest of the app. Run across the rest of the app on
 * 2026-08-27 it found twenty-five more controls in nine screens, of the same
 * two shapes:
 *
 *   * the API says `.int()` and the input takes decimals. Every port field
 *     outside the node forms, every user limit, the whole AmneziaWG
 *     obfuscation block, both Brutal bandwidths, the Mieru MTU.
 *   * the input's range is wider than the API's. `Jmin`/`Jmax` started at 0
 *     against `.min(64)`; `maxUsers` on the node page started at 0 against
 *     `.positive()` while the same field in the node MODAL started at 1;
 *     device limits and expiry days offered a 0 the form then sent verbatim.
 *
 * Neither shape fails quietly-but-harmlessly: the operator types a value the
 * control accepted, presses save, and the API refuses it.
 *
 * The rule is one-directional on purpose. A control may be STRICTER than the
 * API — a cap of 100 devices where the API takes any positive integer is a
 * product decision — but it may never offer what the API refuses.
 *
 * Both sides are read from source. The table below is the mapping (which
 * control answers to which schema field) and nothing else: no bound is written
 * down twice.
 */

const HERE = import.meta.dirname;
const SRC = join(HERE, '..');
const BACKEND = join(HERE, '..', '..', '..', 'panel-backend', 'src');

interface Site {
  /** Frontend file, relative to src/. */
  form: string;
  /** Substring that identifies the NumberInput. Usually its form binding. */
  anchor: string;
  /** Backend file, relative to panel-backend/src/. */
  schema: string;
  /** The field name in that schema. */
  field: string;
  /**
   * The form maps 0 to "unset" before it posts, so a floor of 0 is the form
   * translating rather than the form offering something refused. The
   * translation itself is asserted, not taken on trust.
   */
  zeroIsUnset?: string;
}

const INBOUNDS = 'modules/inbounds/inbounds.schemas.ts';
const PROFILE_FORM = 'components/ProfileFormModal.tsx';

const SITES: Site[] = [
  // ── Hysteria 2
  { form: PROFILE_FORM, anchor: "getInputProps('hyBrutalUp')", schema: INBOUNDS, field: 'brutalUpMbps' },
  { form: PROFILE_FORM, anchor: "getInputProps('hyBrutalDown')", schema: INBOUNDS, field: 'brutalDownMbps' },
  { form: PROFILE_FORM, anchor: "getInputProps('hyPortHopStart')", schema: INBOUNDS, field: 'portHoppingStart' },
  { form: PROFILE_FORM, anchor: "getInputProps('hyPortHopEnd')", schema: INBOUNDS, field: 'portHoppingEnd' },
  // ── Xray REALITY tuning
  { form: PROFILE_FORM, anchor: "getInputProps('xrayRealityMaxTimeDiff')", schema: INBOUNDS, field: 'realityMaxTimeDiff' },
  { form: PROFILE_FORM, anchor: "getInputProps('xrayRealityLimitFallbackUpload')", schema: INBOUNDS, field: 'realityLimitFallbackUploadBytesPerSec' },
  { form: PROFILE_FORM, anchor: "getInputProps('xrayRealityLimitFallbackDownload')", schema: INBOUNDS, field: 'realityLimitFallbackDownloadBytesPerSec' },
  // ── AmneziaWG obfuscation
  { form: PROFILE_FORM, anchor: "getInputProps('awgJc')", schema: INBOUNDS, field: 'jc' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgJmin')", schema: INBOUNDS, field: 'jmin' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgJmax')", schema: INBOUNDS, field: 'jmax' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgS1')", schema: INBOUNDS, field: 's1' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgS2')", schema: INBOUNDS, field: 's2' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgS3')", schema: INBOUNDS, field: 's3' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgS4')", schema: INBOUNDS, field: 's4' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgH1')", schema: INBOUNDS, field: 'h1' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgH2')", schema: INBOUNDS, field: 'h2' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgH3')", schema: INBOUNDS, field: 'h3' },
  { form: PROFILE_FORM, anchor: "getInputProps('awgH4')", schema: INBOUNDS, field: 'h4' },
  // ── Mieru
  { form: PROFILE_FORM, anchor: "getInputProps('mieruMtu')", schema: INBOUNDS, field: 'mtu' },
  // ── Ports that are their own field (the node's own port is folded into
  //    `address` as host:port and validated by a regex, so it is not here)
  { form: 'components/DeployProfileModal.tsx', anchor: 'value={port}', schema: 'modules/profiles/profiles.schemas.ts', field: 'port' },
  { form: 'components/HostsManager.tsx', anchor: "getInputProps('portOverride')", schema: 'modules/hosts/hosts.schemas.ts', field: 'portOverride' },
  { form: 'pages/HostEditPage.tsx', anchor: 'value={port}', schema: 'modules/hosts/hosts.schemas.ts', field: 'port' },
  { form: 'components/NodeEditModal.tsx', anchor: 'value={portDrafts[binding.id]', schema: 'modules/profiles/profiles.schemas.ts', field: 'port' },
  { form: 'components/NodeEditModal.tsx', anchor: "getInputProps('zapret2SocksPort')", schema: 'modules/egress/egress.zapret2.ts', field: 'socksPort' },
  // ── Node capacity
  { form: 'components/NodeEditModal.tsx', anchor: "getInputProps('maxUsers')", schema: 'modules/nodes/nodes.schemas.ts', field: 'maxUsers' },
  { form: 'pages/NodeEditPage.tsx', anchor: "getInputProps('maxUsers')", schema: 'modules/nodes/nodes.schemas.ts', field: 'maxUsers' },
  // ── User and squad limits
  { form: 'components/UserDrawer.tsx', anchor: "getInputProps('hwidDeviceLimit')", schema: 'modules/users/users.schemas.ts', field: 'hwidDeviceLimit' },
  {
    form: 'components/UserDrawer.tsx',
    anchor: "getInputProps('trafficLimitGb')",
    schema: 'modules/users/users.schemas.ts',
    field: 'trafficLimitGb',
    zeroIsUnset: 'Number(values.trafficLimitGb) || null',
  },
  { form: 'components/UserDrawer.tsx', anchor: "getInputProps('expireDays')", schema: 'modules/users/users.schemas.ts', field: 'expireDays' },
  { form: 'components/SquadFormModal.tsx', anchor: "getInputProps('hwidDeviceLimit')", schema: 'modules/squads/squads.schemas.ts', field: 'hwidDeviceLimit' },
  { form: 'pages/SquadEditPage.tsx', anchor: 'value={hwidLimit}', schema: 'modules/squads/squads.schemas.ts', field: 'hwidDeviceLimit' },
  // ── Routing rules
  { form: 'pages/SrrRulePage.tsx', anchor: 'value={draft.priority', schema: 'modules/srr/srr.schemas.ts', field: 'priority' },
];

/**
 * The props of the NumberInput that carries `anchor`.
 *
 * Throws rather than returning nothing. An extraction that stopped matching
 * would make every case vacuously true, which is exactly the shape that let the
 * multiplier survive for months.
 */
function inputProps(src: string, anchor: string, where: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`no "${anchor}" in ${where}`);
  const open = src.lastIndexOf('<NumberInput', at);
  if (open < 0) throw new Error(`"${anchor}" in ${where} is not inside a NumberInput`);
  // Walk to the tag's own close, so props written after the anchor count too.
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0 && ch === '/' && src[i + 1] === '>') {
      return src.slice(open, i);
    }
  }
  throw new Error(`unterminated NumberInput around "${anchor}" in ${where}`);
}

interface Rule {
  int: boolean;
  min: number | null;
  max: number | null;
  decls: string[];
}

/**
 * The zod rule for one field, as the API enforces it.
 *
 * A field can be declared more than once in a schema file — a create shape and
 * an update shape — and the control has to satisfy whichever endpoint it posts
 * to, so the bounds are intersected: the highest floor and the lowest ceiling.
 * `field: PortSchema` is resolved through the `const` beside it, because a rule
 * given a name is still the rule.
 */
function zodRule(src: string, field: string, where: string): Rule {
  const decls: string[] = [];
  const re = new RegExp(`^\\s*${field}:\\s*([A-Za-z_$][\\w$.]*\\([^\\n]*|[A-Za-z_$][\\w$]*[^\\n]*)$`, 'gm');
  for (const m of src.matchAll(re)) {
    let expr = m[1]!.replace(/,\s*(\/\/.*)?$/, '').trim();
    if (!expr.startsWith('z.')) {
      const name = /^([A-Za-z_$][\w$]*)/.exec(expr)?.[1];
      const named = name
        ? new RegExp(`^const ${name} = (z\\.[^\\n]+?);?$`, 'm').exec(src)?.[1]
        : undefined;
      if (!named) continue;
      expr = named + expr.slice(name!.length);
    }
    decls.push(expr);
  }
  if (decls.length === 0) throw new Error(`no numeric rule for ${field} in ${where}`);

  let min: number | null = null;
  let max: number | null = null;
  let int = true;
  for (const d of decls) {
    if (!d.includes('.int()')) int = false;
    const floor = d.includes('.positive()')
      ? 1
      : Number(/\.min\((-?[\d_]+)\)/.exec(d)?.[1] ?? NaN);
    if (Number.isFinite(floor)) min = min === null ? floor : Math.max(min, floor);
    const ceil = Number(/\.max\((-?[\d_]+)\)/.exec(d)?.[1] ?? NaN);
    if (Number.isFinite(ceil)) max = max === null ? ceil : Math.min(max, ceil);
  }
  return { int, min, max, decls };
}

const num = (props: string, prop: string): number | null => {
  const m = new RegExp(`\\b${prop}=\\{(-?[\\d.]+)\\}`).exec(props);
  return m ? Number(m[1]) : null;
};

const backendPresent = existsSync(BACKEND);

describe('every numeric control offers only what its API accepts', () => {
  it('the table names live files on both sides', () => {
    // The control. A renamed file would otherwise turn every case below into a
    // thrown error nobody reads, or worse, a skip.
    for (const s of SITES) {
      expect(existsSync(join(SRC, s.form)), `${s.form} is gone`).toBe(true);
      if (backendPresent) {
        expect(existsSync(join(BACKEND, s.schema)), `${s.schema} is gone`).toBe(true);
      }
    }
    expect(SITES.length, 'sites were added or removed').toBeGreaterThanOrEqual(32);
  });

  const name = (s: Site) => `${s.form.split('/').pop()} ${s.field}`;

  it.each(SITES.map((s) => [name(s), s] as const))(
    '%s takes only whole numbers when the API says .int()',
    (_label, s) => {
      if (!backendPresent) return;
      const rule = zodRule(readFileSync(join(BACKEND, s.schema), 'utf8'), s.field, s.schema);
      if (!rule.int) return;
      const props = inputProps(readFileSync(join(SRC, s.form), 'utf8'), s.anchor, s.form);
      expect(props, `${s.field} is .int() in ${s.schema}: ${rule.decls[0]}`).toContain(
        'allowDecimal={false}',
      );
    },
  );

  it.each(SITES.map((s) => [name(s), s] as const))(
    '%s starts no lower than the API floor',
    (_label, s) => {
      if (!backendPresent) return;
      const rule = zodRule(readFileSync(join(BACKEND, s.schema), 'utf8'), s.field, s.schema);
      if (rule.min === null) return;
      const src = readFileSync(join(SRC, s.form), 'utf8');
      const props = inputProps(src, s.anchor, s.form);
      const min = num(props, 'min');
      expect(min, `no min= on ${s.field} in ${s.form}`).not.toBeNull();
      if (s.zeroIsUnset !== undefined && min === 0) {
        // The waiver is itself checked: the form must really translate the 0,
        // or the floor of 0 is just a floor of 0.
        expect(src, `${s.form} no longer maps 0 to null for ${s.field}`).toContain(s.zeroIsUnset);
        return;
      }
      expect(min!, `the stepper reaches ${min}, the API refuses below ${rule.min}`).toBeGreaterThanOrEqual(
        rule.min,
      );
    },
  );

  it.each(SITES.map((s) => [name(s), s] as const))(
    '%s stops no higher than the API ceiling',
    (_label, s) => {
      if (!backendPresent) return;
      const rule = zodRule(readFileSync(join(BACKEND, s.schema), 'utf8'), s.field, s.schema);
      if (rule.max === null) return;
      const props = inputProps(readFileSync(join(SRC, s.form), 'utf8'), s.anchor, s.form);
      const max = num(props, 'max');
      expect(max, `${s.field} has no max= but the API caps it at ${rule.max}`).not.toBeNull();
      expect(max!, `the control offers ${max}, the API caps at ${rule.max}`).toBeLessThanOrEqual(
        rule.max,
      );
    },
  );

  it('the parsers answer about something, on both sides', () => {
    // Without this, a regex that stopped matching would make the three suites
    // above pass by returning null everywhere.
    if (!backendPresent) {
      expect.fail('CROSS-REPO HALF NOT RUN: panel-backend is not next to this checkout');
    }
    const jmin = zodRule(readFileSync(join(BACKEND, INBOUNDS), 'utf8'), 'jmin', INBOUNDS);
    expect(jmin.int).toBe(true);
    expect(jmin.min).toBe(64);
    expect(jmin.max).toBe(1024);

    const port = zodRule(
      readFileSync(join(BACKEND, 'modules/profiles/profiles.schemas.ts'), 'utf8'),
      'port',
      'profiles.schemas.ts',
    );
    expect(port.int, 'the named-constant path (PortSchema) stopped resolving').toBe(true);
    expect(port.max).toBe(65535);

    const props = inputProps(
      readFileSync(join(SRC, PROFILE_FORM), 'utf8'),
      "getInputProps('awgJmin')",
      PROFILE_FORM,
    );
    expect(num(props, 'min')).toBe(64);
    expect(props).toContain('allowDecimal={false}');
  });
});
