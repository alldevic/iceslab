import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every form control has a NAME, one way or another.
 *
 * A control with neither `label` nor `aria-label` has no accessible name at
 * all. A `placeholder` is not one: it disappears the moment anything is typed,
 * and half of the ones here are examples rather than names
 * (`geosite:google  geoip:private`, `why this rule exists`) - a value's shape,
 * not the field's identity.
 *
 * Measured 2026-08-30: four components rendered fifteen such controls
 * (SrrRulePage, SubscriptionMetadataPage, DevicePresetEditor,
 * RoutePolicyEditor), plus the username field in UserDrawer. All five drew a
 * VISIBLE label next to the field with a custom component - `FieldLabel`,
 * `Section` - which renders text, not a `<label for=...>`. So the screen reader
 * had nothing and the screenshot looked fine, which is why three separate
 * sessions walked past it.
 *
 * Named rather than relabelled, on purpose: `aria-label` gives the control a
 * name without moving a pixel, because those layouts put the label where a
 * Mantine `label=` would not.
 *
 * ── Why a source mirror ──
 *
 * The alternative is rendering all 45 screens and asking the DOM, which is what
 * the mount suite does; this catches the case that suite cannot, which is a new
 * control added tomorrow to a form nobody re-reads. It is a source scan and
 * says so: it strips comments first, it proves it found controls at all before
 * concluding anything, and what it still lets past is listed site by site.
 */

const SRC = join(import.meta.dirname, '..');

/** Controls that take a user-entered value and therefore need a name. */
const CONTROL =
  /<(TextInput|NumberInput|PasswordInput|Textarea|JsonInput|Select|MultiSelect|Autocomplete|TagsInput|Switch|Checkbox|Radio|SegmentedControl|Slider|ColorInput|FileInput|DateInput|DatePickerInput)\b/g;

/**
 * The controls that still have no name, as measured on 2026-08-30.
 *
 * This is a RATCHET, not an exemption list. The four components this session
 * was asked to fix are not in it - they are named. What is in it is the rest of
 * the family, which the same scan turned up once it existed: fifteen were
 * counted by hand from the files that had NO labels at all, and the scan found
 * forty-eight, because a file with SOME labelled controls can still have
 * unlabelled ones. Two ways of counting disagreed and the smaller one was
 * wrong, which is the usual outcome.
 *
 * Kept as exact sites rather than whole files on purpose: a file-level
 * exemption stops checking the file, and these files are where new controls get
 * added. Anything NEW fails; the list can only shrink.
 *
 * Naming these is not mechanical - most need a string that does not exist yet,
 * in two languages, and a name is a product decision about wording. That is why
 * they are recorded rather than guessed at.
 */
const KNOWN_UNNAMED = new Set<string>([
  'components/CascadeEditor.tsx:149 <Select>',
  'components/CascadeEditor.tsx:487 <Select>',
  'components/CascadeEditor.tsx:499 <Select>',
  'components/CascadeEditor.tsx:625 <Select>',
  'components/CascadeEditor.tsx:1244 <Switch>',
  'components/CascadeEditor.tsx:1285 <Switch>',
  'components/DeployProfileModal.tsx:296 <Checkbox>',
  'components/GeoPanel.tsx:240 <Switch>',
  'components/GeoPanel.tsx:320 <Switch>',
  'components/GeoPanel.tsx:474 <SegmentedControl>',
  'components/GeoPanel.tsx:490 <TextInput>',
  'components/GeoPanel.tsx:723 <Select>',
  'components/GeoPanel.tsx:732 <TextInput>',
  'components/HostsManager.tsx:316 <Switch>',
  'components/NodeEditModal.tsx:1237 <NumberInput>',
  'components/NodeFormModal.tsx:626 <Checkbox>',
  'components/ProfileFormModal.tsx:1435 <PasswordInput>',
  'components/ProfileFormModal.tsx:1954 <SegmentedControl>',
  'components/RecipePicker.tsx:136 <TextInput>',
  'components/RecipePicker.tsx:418 <SegmentedControl>',
  'components/SquadFormModal.tsx:414 <TextInput>',
  'components/SquadFormModal.tsx:510 <Checkbox>',
  'components/SquadFormModal.tsx:561 <Checkbox>',
  'components/SquadFormModal.tsx:665 <Checkbox>',
  'components/SquadFormModal.tsx:728 <Checkbox>',
  'components/Toolbar.tsx:44 <TextInput>',
  'components/UserDrawer.tsx:723 <Select>',
  'pages/CascadeCreatePage.tsx:347 <TextInput>',
  'pages/CascadeEditPage.tsx:439 <TextInput>',
  'pages/HostEditPage.tsx:586 <Select>',
  'pages/HostsPage.tsx:234 <Select>',
  'pages/NodeCreatePage.tsx:763 <TagsInput>',
  'pages/NodeCreatePage.tsx:1739 <Switch>',
  'pages/ProfilesPage.tsx:282 <Select>',
  'pages/RoutesPage.tsx:645 <Textarea>',
  'pages/RoutesPage.tsx:954 <Textarea>',
  'pages/SettingsPage.tsx:200 <TextInput>',
  'pages/SettingsPage.tsx:727 <TextInput>',
  'pages/SettingsPage.tsx:735 <TextInput>',
  'pages/SettingsPage.tsx:782 <TextInput>',
  'pages/SettingsPage.tsx:789 <TextInput>',
  'pages/SettingsPage.tsx:900 <TextInput>',
  'pages/SettingsPage.tsx:925 <TextInput>',
  'pages/SettingsPage.tsx:1132 <Switch>',
  'pages/SettingsPage.tsx:1153 <TextInput>',
  'pages/SettingsPage.tsx:1161 <TextInput>',
  'pages/SrrPage.tsx:349 <TextInput>',
  'pages/UsersPage.tsx:1089 <Select>',
]);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === 'test') continue;
      out.push(...tsxFiles(p));
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments: prose around a control mentions `label` constantly. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The props of one JSX element, from its `<Tag` to the `>` that closes the
 * opening tag. Nested braces are tracked so a `styles={{...}}` object with a
 * `>` inside a string cannot end the scan early.
 */
function openingTag(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(from, i);
  }
  return src.slice(from, from + 400);
}

interface Unnamed {
  file: string;
  tag: string;
  line: number;
}

/** Every site with no accessible name, ratchet included. */
function allUnnamedSites(): string[] {
  const out: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(CONTROL)) {
      const props = openingTag(src, m.index!);
      if (/\blabel=/.test(props) || /\baria-label=/.test(props) || /\baria-labelledby=/.test(props)) {
        continue;
      }
      out.push(`${rel}:${src.slice(0, m.index!).split('\n').length} <${m[1]}>`);
    }
  }
  return out;
}

function unnamedControls(): Unnamed[] {
  const found: Unnamed[] = [];
  let controlsSeen = 0;
  for (const file of tsxFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(CONTROL)) {
      controlsSeen++;
      const props = openingTag(src, m.index!);
      if (/\blabel=/.test(props) || /\baria-label=/.test(props) || /\baria-labelledby=/.test(props)) {
        continue;
      }
      const line = src.slice(0, m.index!).split('\n').length;
      const site = `${rel}:${line} <${m[1]}>`;
      if (KNOWN_UNNAMED.has(site)) continue;
      found.push({ file: rel, tag: m[1]!, line });
    }
  }
  // The control, and it is not decorative: a scan that matched nothing would
  // report "no unnamed controls" about a codebase it never read.
  expect(controlsSeen, 'the scan found no form controls at all').toBeGreaterThan(150);
  return found;
}

describe('every form control carries an accessible name', () => {
  it('finds none without one', () => {
    const unnamed = unnamedControls();
    expect(
      unnamed.map((u) => `${u.file}:${u.line} <${u.tag}>`),
      'a control with neither label nor aria-label has no accessible name; a placeholder is not one - it vanishes on the first keystroke, and several of ours are examples rather than names',
    ).toEqual([]);
  });

  // The ratchet only ratchets if it cannot quietly grow. A site named here that
  // is no longer unnamed - because someone fixed it, or because the line moved -
  // has to come out, or the list drifts into excusing whatever now sits on that
  // line.
  it('keeps no entry that is already named', () => {
    const stillUnnamed = new Set(allUnnamedSites());
    const stale = [...KNOWN_UNNAMED].filter((s) => !stillUnnamed.has(s));
    expect(
      stale,
      'these are recorded as unnamed but are not: name-and-forget is how a ratchet becomes an exemption list',
    ).toEqual([]);
  });
});
