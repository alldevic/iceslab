import { describe, expect, it } from 'vitest';

/**
 * Every form control has a NAME, one way or another.
 *
 * A control with neither `label` nor `aria-label` has no accessible name. A
 * `placeholder` is not one: it vanishes on the first keystroke, and many are
 * examples of a value rather than the field's identity. The screens draw a
 * visible caption beside most such fields with a custom component (`FieldLabel`,
 * `CardCaption`) that renders text, not a `<label for=...>` - the screenshot
 * looks right and a screen reader gets nothing. `aria-label` names the control
 * without moving a pixel.
 *
 * This is a source scan, and says so: it strips comments, proves it found
 * controls at all, and what it lets past is listed below. A control that gets
 * its `label` through a spread of props or a wrapper counts as unnamed (the scan
 * cannot see it), and so does a control inside a wrapper like `Section`.
 *
 * It lives in ui/ because it reads every contour; no single contour may own it.
 */
const FILES = import.meta.glob('/src/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Controls that take a user-entered value and therefore need a name. */
const CONTROL =
  /<(TextInput|NumberInput|PasswordInput|Textarea|JsonInput|Select|MultiSelect|Autocomplete|TagsInput|Switch|Checkbox|Radio|SegmentedControl|Slider|ColorInput|FileInput|DateInput|DatePickerInput)\b/g;

/**
 * The controls that still have no name, as `file <Tag>` -> how many in that
 * file. A RATCHET, not an exemption list: nothing may be added, and the number
 * for an entry has to go down when a control is named (the second test fails on
 * a stale count). Keyed by file + tag + count rather than by line, because any
 * edit above a control moves its line.
 *
 * Naming these needs wording that does not exist yet, in two languages - a
 * product decision - so they are recorded rather than guessed at.
 */
const KNOWN_UNNAMED: Record<string, number> = {
  'contours/cascades/components/CascadeEditor.tsx <SegmentedControl>': 2,
  'contours/cascades/components/CascadeEditor.tsx <Select>': 11,
  'contours/cascades/components/CascadeEditor.tsx <Switch>': 2,
  'contours/cascades/screens/CascadeCreatePage.tsx <TextInput>': 1,
  'contours/cascades/screens/CascadeEditPage.tsx <TextInput>': 1,
  'contours/hosts/screens/HostEditPage.tsx <Radio>': 1,
  'contours/hosts/screens/HostEditPage.tsx <Select>': 1,
  'contours/hosts/screens/HostsPage.tsx <Select>': 1,
  'contours/nodes/components/NodeCreate/StepParams.tsx <TagsInput>': 1,
  'contours/nodes/components/NodeCreate/ToggleRow.tsx <Switch>': 1,
  'contours/profiles/components/DeployProfileModal.tsx <Checkbox>': 1,
  'contours/profiles/components/ProfileForm/AmneziawgSection.tsx <SegmentedControl>': 1,
  'contours/profiles/components/ProfileForm/XraySection.tsx <PasswordInput>': 1,
  'contours/profiles/components/RecipePicker.tsx <SegmentedControl>': 1,
  'contours/profiles/components/RecipePicker.tsx <TextInput>': 1,
  'contours/profiles/screens/ProfilesPage.tsx <Select>': 1,
  'contours/settings/screens/SettingsPage.tsx <Switch>': 1,
  'contours/settings/screens/SettingsPage.tsx <TextInput>': 9,
  'contours/subscription/screens/SrrPage.tsx <TextInput>': 1,
  'contours/subscription/screens/SubscriptionDeliveryPage.tsx <TextInput>': 1,
  'contours/subscription/screens/SubscriptionDeliveryPage.tsx <Textarea>': 1,
  'contours/subscription/screens/TemplateEditPage.tsx <Select>': 1,
  'contours/subscription/screens/TemplateEditPage.tsx <TextInput>': 1,
  'contours/traffic/components/CompositeEditor.tsx <Select>': 3,
  'contours/traffic/components/CompositeEditor.tsx <TextInput>': 2,
  'contours/traffic/components/CompositeEditor.tsx <Textarea>': 2,
  'contours/traffic/components/NodePolicy/NodePolicyEditor.tsx <TextInput>': 1,
  'contours/traffic/components/NodePolicy/RuleRow.tsx <TextInput>': 1,
  'contours/traffic/components/Routes/Bucket.tsx <Textarea>': 1,
  'contours/traffic/components/Routes/OwnRules.tsx <Textarea>': 1,
  'contours/traffic/screens/GeoSetsPage.tsx <NumberInput>': 1,
  'contours/traffic/screens/GeoSetsPage.tsx <SegmentedControl>': 1,
  'contours/traffic/screens/GeoSetsPage.tsx <Select>': 2,
  'contours/traffic/screens/GeoSetsPage.tsx <TextInput>': 5,
  'contours/traffic/screens/NamedOutboundsPage.tsx <SegmentedControl>': 2,
  'contours/users/components/UsersTable/ColumnFilter.tsx <Select>': 4,
  'contours/users/components/UsersTable/ColumnsPanel.tsx <Switch>': 1,
  'contours/users/components/UsersTable/UsersTable.tsx <Select>': 1,
  'ui/Toolbar.tsx <TextInput>': 1,
};

/** Strip comments: the prose around a control mentions `label` constantly. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`\\])\/\/[^\n]*/g, '');

/**
 * The props of one JSX element, from its `<Tag` to the `>` that closes the
 * opening tag. Braces are tracked so an arrow `=>` or a `>` inside a prop
 * expression cannot end the scan early.
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

const NAMED = /\blabel=|\baria-label=|\baria-labelledby=/;

function scan(): { seen: number; unnamed: Record<string, number> } {
  let seen = 0;
  const unnamed: Record<string, number> = {};
  for (const [path, raw] of Object.entries(FILES)) {
    if (path.endsWith('.test.tsx')) continue;
    const src = stripComments(raw);
    for (const m of src.matchAll(CONTROL)) {
      seen += 1;
      if (NAMED.test(openingTag(src, m.index))) continue;
      const key = `${path.slice('/src/'.length)} <${m[1]}>`;
      unnamed[key] = (unnamed[key] ?? 0) + 1;
    }
  }
  return { seen, unnamed };
}

describe('every form control carries an accessible name', () => {
  const { seen, unnamed } = scan();
  it('finds form controls at all (the scan itself has to work)', () => {
    // An empty scan would report "no unnamed controls" about code it never read.
    expect(seen).toBeGreaterThan(200);
  });

  it('no unnamed control beyond the recorded ones', () => {
    const grown = Object.entries(unnamed)
      .filter(([k, n]) => n > (KNOWN_UNNAMED[k] ?? 0))
      .map(([k, n]) => `${k}: ${n} unnamed, ${KNOWN_UNNAMED[k] ?? 0} recorded`);
    expect(
      grown,
      'a control with neither label nor aria-label has no accessible name; a placeholder is not one',
    ).toEqual([]);
  });

  it('keeps no recorded entry that is already named', () => {
    const stale = Object.entries(KNOWN_UNNAMED)
      .filter(([k, n]) => (unnamed[k] ?? 0) < n)
      .map(([k, n]) => `${k}: ${unnamed[k] ?? 0} unnamed, ${n} recorded`);
    expect(
      stale,
      'name-and-forget is how a ratchet becomes an exemption list: lower the count or remove the entry',
    ).toEqual([]);
  });
});
