import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { UpdateSrrSchema } from '../../../panel-backend/src/modules/srr/srr.schemas';
import { UpdateHostSchema } from '../../../panel-backend/src/modules/hosts/hosts.schemas';
import { aBinding, aCascade, aHost, aNode, aProfile } from '../test/records';
import { UpdateSettingsSchema } from '../../../panel-backend/src/modules/settings/settings.schemas';

/**
 * The same door §57 and §58.1 put on the profile, the node, the squad and the
 * user, asked of the pages that edit the remaining records.
 *
 * These update field by field under `!== undefined` guards, so an OMITTED field
 * is safe; what is not safe is a field the page sends with a default instead of
 * with the record's value. That is the shape §51 found in the node form and
 * §58.1 found three more of.
 *
 * Each case edits exactly ONE field and then asserts every OTHER one came back
 * unchanged. Not decoration: these pages gate Save on `dirty`, so an untouched
 * record cannot be saved at all — which is correct, and which a case that
 * pressed Save on an untouched form would have read as a refusal.
 *
 * SettingsPage is deliberately not here: its two controls each send exactly one
 * key of their own (`{brandName}`, `{defaultLocale}`), so there is no record to
 * round-trip and a case for it would assert nothing.
 *
 * NAMED RATHER THAN WORKED AROUND: neither page renders a single `<label>`
 * element — measured, `document.querySelectorAll('label')` is empty on both — so
 * no input here has an accessible name and `getByLabelText` cannot reach any of
 * them. That is the same gap already recorded for `UserDrawer`'s username
 * field, at the scale of two whole pages. The cases below select by the value
 * the field was seeded with, which is honest about what a screen reader would
 * find: nothing.
 */

const listSrrRules = vi.fn();
const updateSrrRule = vi.fn<(id: string, input: unknown) => Promise<object>>(async () => ({}));
const getSettings = vi.fn();
const updateSettings = vi.fn<(input: unknown) => Promise<object>>(async () => ({}));
const listHosts = vi.fn();
const listBindings = vi.fn();
const listNodes = vi.fn();
const listProfiles = vi.fn();
const getProfileHostFields = vi.fn<(id: string) => Promise<unknown>>();
const updateHost = vi.fn<(id: string, input: unknown) => Promise<object>>(async () => ({}));
const listCascades = vi.fn();
const getCascadeStatus = vi.fn<(id: string) => Promise<unknown>>();
const updateCascadeV4 = vi.fn<(id: string, input: unknown) => Promise<unknown>>();

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listSrrRules: (...a: unknown[]) => listSrrRules(...a),
    updateSrrRule: (id: string, input: unknown) => updateSrrRule(id, input),
    getSettings: () => getSettings(),
    updateSettings: (input: unknown) => updateSettings(input),
    listHosts: (...a: unknown[]) => listHosts(...a),
    listBindings: (...a: unknown[]) => listBindings(...a),
    listNodes: (...a: unknown[]) => listNodes(...a),
    listProfiles: (...a: unknown[]) => listProfiles(...a),
    getProfileHostFields: (id: string) => getProfileHostFields(id),
    updateHost: (id: string, input: unknown) => updateHost(id, input),
    listCascades: () => listCascades(),
    getCascadeStatus: (id: string) => getCascadeStatus(id),
    updateCascadeV4: (id: string, input: unknown) => updateCascadeV4(id, input),
  };
});

import { CascadeEditPage } from './CascadeEditPage';
import { HostEditPage } from './HostEditPage';
import { SrrRulePage } from './SrrRulePage';
import { SubscriptionMetadataPage } from './SubscriptionMetadataPage';

interface Schema {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
}

async function saved(fn: ReturnType<typeof vi.fn>, schema: Schema, argIndex: number) {
  await waitFor(() => {
    if (fn.mock.calls.length >= 1) return;
    const said = Array.from(document.querySelectorAll('.mantine-InputWrapper-error'))
      .map((el) => el.textContent)
      .filter(Boolean);
    throw new Error(
      `the page refused to re-save a record it had just been handed${said.length ? `: ${said.join(' | ')}` : ' and said nothing about why'}`,
    );
  });
  const payload = (fn.mock.calls as unknown[][])[0][argIndex] as Record<string, unknown>;
  const parsed = schema.safeParse(payload);
  expect(
    parsed.success ? [] : parsed.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    `the API refuses what this page sent back: ${JSON.stringify(payload)}`,
  ).toEqual([]);
  return payload;
}

describe('an edit PAGE sends back the record it was given', () => {
  it('delivery rule: every field the page submits still holds what the rule held', async () => {
    const rule = {
      id: 'rule-1',
      name: 'Clash clients',
      uaPattern: '(?i)clash|stash',
      format: 'clash' as const,
      priority: 7,
      enabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    listSrrRules.mockResolvedValue({ rules: [rule] });
    updateSrrRule.mockClear();

    const { user } = renderWithProviders(
      <Routes>
        <Route path="/subscription/delivery/:id" element={<SrrRulePage />} />
      </Routes>,
      { route: `/subscription/delivery/${rule.id}` },
    );

    // The one field this case edits; everything else must survive it. By value,
    // because this page draws no <label> for it — see the header.
    const name = await screen.findByDisplayValue('Clash clients');
    await user.clear(name);
    await user.click(name);
    await user.paste('Clash clients (renamed)');

    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    const p = await saved(updateSrrRule, UpdateSrrSchema, 1);

    expect(p.name).toBe('Clash clients (renamed)');
    expect(p.uaPattern).toBe(rule.uaPattern);
    expect(p.format).toBe(rule.format);
    expect(p.priority).toBe(rule.priority);
    expect(p.enabled, 'a disabled rule came back enabled').toBe(rule.enabled);
  });

  it('subscription metadata: every field the page submits still holds what the settings held', async () => {
    const settings = {
      brandName: 'Iceslab',
      subscriptionProfileTitle: 'My VPN',
      subscriptionUpdateIntervalHours: 6,
      subscriptionSupportUrl: 'https://support.example.com',
      subscriptionAnnounceTemplate: 'hello {{username}}',
      subscriptionRoutingPreset: 'ru-split' as const,
      subscriptionEntryPoolSize: 3,
      subscriptionTlsFragment: true,
    };
    getSettings.mockResolvedValue(settings);
    updateSettings.mockClear();

    const { user } = renderWithProviders(<SubscriptionMetadataPage />);
    const title = await screen.findByDisplayValue('My VPN');
    await user.clear(title);
    await user.click(title);
    await user.paste('My VPN (renamed)');

    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    const p = await saved(updateSettings, UpdateSettingsSchema, 0);

    expect(p.subscriptionProfileTitle).toBe('My VPN (renamed)');
    expect(p.subscriptionUpdateIntervalHours).toBe(settings.subscriptionUpdateIntervalHours);
    expect(p.subscriptionSupportUrl).toBe(settings.subscriptionSupportUrl);
    expect(p.subscriptionAnnounceTemplate).toBe(settings.subscriptionAnnounceTemplate);
    expect(p.subscriptionRoutingPreset).toBe(settings.subscriptionRoutingPreset);
    expect(p.subscriptionEntryPoolSize).toBe(settings.subscriptionEntryPoolSize);
    expect(p.subscriptionTlsFragment).toBe(settings.subscriptionTlsFragment);
  });

  it('host: every override the page submits still holds what the host held', async () => {
    // A profile that CAN serve every override, so the page's own `can()` gate
    // is not what the case measures: a field the profile cannot serve is sent
    // as null on purpose, and that is a different rule from this one.
    const profile = aProfile({ id: 'profile-1', protocol: 'xray' as ReturnType<typeof aProfile>['protocol'] });
    const node = aNode({ id: 'node-1' });
    const binding = aBinding({ id: 'binding-1', profileId: profile.id, nodeId: node.id, port: 443 });
    const host = aHost({
      id: 'host-1',
      bindingId: binding.id,
      remark: 'Amsterdam',
      enabled: false,
      addressOverride: 'ams.example.com',
      portOverride: 8443,
      sniOverride: 'www.cloudflare.com',
      hostHeaderOverride: 'cdn.example.com',
      pathOverride: '/probe',
      fingerprintOverride: 'firefox' as ReturnType<typeof aHost>['fingerprintOverride'],
      alpn: ['h2', 'http/1.1'],
      securityLayer: 'tls' as ReturnType<typeof aHost>['securityLayer'],
      disableForFormats: ['clash'],
    });
    listHosts.mockResolvedValue({ hosts: [host] });
    listBindings.mockResolvedValue({ bindings: [binding] });
    listNodes.mockResolvedValue({ nodes: [node], total: 1, page: 1, limit: 100 });
    listProfiles.mockResolvedValue({ profiles: [profile] });
    getProfileHostFields.mockResolvedValue({
      fields: Object.fromEntries(
        ['sniOverride', 'hostHeaderOverride', 'pathOverride', 'fingerprintOverride', 'alpn', 'securityLayer'].map(
          (f) => [f, { supported: true }],
        ),
      ),
    });
    updateHost.mockClear();

    const { user } = renderWithProviders(
      <Routes>
        <Route path="/hosts/:id" element={<HostEditPage />} />
      </Routes>,
      { route: `/hosts/${host.id}` },
    );

    const remark = await screen.findByDisplayValue('Amsterdam');
    await user.clear(remark);
    await user.click(remark);
    await user.paste('Amsterdam-renamed');

    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    const p = await saved(updateHost, UpdateHostSchema, 1);

    expect(p.remark).toBe('Amsterdam-renamed');
    expect(p.enabled, 'a disabled host came back enabled').toBe(host.enabled);
    expect(p.addressOverride).toBe(host.addressOverride);
    expect(p.portOverride).toBe(host.portOverride);
    expect(p.sniOverride).toBe(host.sniOverride);
    expect(p.hostHeaderOverride).toBe(host.hostHeaderOverride);
    expect(p.pathOverride).toBe(host.pathOverride);
    expect(p.fingerprintOverride).toBe(host.fingerprintOverride);
    expect(p.alpn).toEqual(host.alpn);
    expect(p.securityLayer).toBe(host.securityLayer);
    expect(p.disableForFormats).toEqual(host.disableForFormats);
  });

  it('cascade: a rename carries the whole topology back, tags and all', async () => {
    // The record with the most to lose: the direction TAG rides inside every
    // client's UUID and squad ACL cuts access by it, so a save that renamed the
    // cascade and dropped or renumbered a direction would cut people off.
    const entry = aNode({ id: 'node-entry', name: 'ams-1' });
    const exitA = aNode({ id: 'node-exit-a', name: 'fra-1', countryCode: 'DE' });
    const exitB = aNode({ id: 'node-exit-b', name: 'sto-1', countryCode: 'SE' });
    const cascade = aCascade({
      id: 'cascade-1',
      name: 'ru-exit',
      enabled: true,
      hideHopsFromSub: false,
      autoProfile: true,
      positions: [
        { position: 0, nodeIds: [entry.id], entryProtocol: 'xray', linkProtocol: 'xray' },
      ],
      directions: [
        { id: 'dir-a', tag: 1, countryCode: 'DE', nodeIds: [exitA.id] },
        { id: 'dir-b', tag: 4, countryCode: 'SE', nodeIds: [exitB.id] },
      ],
      nextDirectionTag: 5,
    });
    listCascades.mockResolvedValue({ cascades: [cascade] });
    listNodes.mockResolvedValue({ nodes: [entry, exitA, exitB], total: 3, page: 1, limit: 100 });
    getCascadeStatus.mockResolvedValue({ done: true, hops: [] });
    updateCascadeV4.mockClear();
    updateCascadeV4.mockResolvedValue(cascade);

    const { user } = renderWithProviders(
      <Routes>
        <Route path="/nodes/cascades/:id" element={<CascadeEditPage />} />
      </Routes>,
      { route: `/nodes/cascades/${cascade.id}` },
    );

    const name = await screen.findByDisplayValue('ru-exit');
    await user.clear(name);
    await user.click(name);
    await user.paste('ru-exit-renamed');

    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(updateCascadeV4).toHaveBeenCalledTimes(1));
    const p = (updateCascadeV4.mock.calls as unknown[][])[0][1] as Record<string, unknown>;

    expect(p.name).toBe('ru-exit-renamed');
    expect(p.enabled).toBe(cascade.enabled);
    expect(p.hideHopsFromSub, 'an unchecked "hide hops" came back checked').toBe(false);
    expect(p.autoProfile, 'the Auto line was switched off by a rename').toBe(true);
    expect(p.positions).toEqual([
      { position: 0, nodeIds: [entry.id], entryProtocol: 'xray', linkProtocol: 'xray' },
    ]);
    // Both directions, in order, each still carrying its own id and pool. The
    // id is what writeTopologyV4 matches a direction to its stored tag by, so
    // losing it renumbers the tag every client authenticates with.
    expect(p.directions).toEqual([
      { id: 'dir-a', nodeIds: [exitA.id], countryCode: 'DE' },
      { id: 'dir-b', nodeIds: [exitB.id], countryCode: 'SE' },
    ]);
  });
});
