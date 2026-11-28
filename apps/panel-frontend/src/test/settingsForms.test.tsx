// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { UpdateSettingsSchema } from '@backend/modules/settings/settings.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { accepted, sameWhereSent, theWrite } from '@/test/formDrive';
import { SubscriptionMetadataPage } from '@/contours/subscription/screens/SubscriptionMetadataPage';
import { SubscriptionDeliveryPage } from '@/contours/subscription/screens/SubscriptionDeliveryPage';
import { SettingsPage } from '@/contours/settings/screens/SettingsPage';
import { OwnRules } from '@/contours/traffic/components/Routes/OwnRules';

/*
 * Every screen that writes `PUT /api/settings`, against the backend's
 * UpdateSettingsSchema (milestone 17.5): the subscription metadata, the
 * delivery setup, the brand name on the settings page and the own routing
 * rules. The language switch writes `defaultLocale` alone and is not mounted.
 *
 * What each screen reads back from the server is a stored settings object;
 * the form is opened on it, one field is changed, and the request is held to
 * the schema. A value the form restates must be the stored one.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 5000 };

function mount(ui: React.ReactNode, route: string, stored: Record<string, unknown>) {
  const api = installEmptyApi({
    routes: [{ re: /^\/api\/settings$/, reply: stored }],
    onWrite: (r) => (r.method === 'PUT' && r.url === '/api/settings' ? { data: stored } : undefined),
  });
  const view = renderWithProviders(
    <Routes>
      <Route path={route} element={ui} />
    </Routes>,
    { route },
  );
  return { api, view };
}
type View = ReturnType<typeof mount>['view'];

async function saved(api: ReturnType<typeof mount>['api']): Promise<Record<string, unknown>> {
  await waitFor(() => theWrite(api.calls, 'PUT', '/api/settings'), FIRST);
  return theWrite(api.calls, 'PUT', '/api/settings').body as Record<string, unknown>;
}

const SUBSCRIPTION = {
  subscriptionProfileTitle: 'My VPN',
  subscriptionUpdateIntervalHours: 12,
  subscriptionEntryPoolSize: 2,
  subscriptionSupportUrl: 'https://support.example.test/help',
  subscriptionAnnounceTemplate: 'Left: {{TRAFFIC_LEFT}}',
  subscriptionRoutingPreset: 'ru-split',
  subscriptionTlsFragment: true,
  subscriptionWgDns: ['1.1.1.1', '2606:4700:4700::1111'],
  subscriptionWgDropIpv6: true,
  wgShowUnusedTunnels: true,
};

describe('subscription metadata page', () => {
  const edit = async (view: View, stored: Record<string, unknown>, interval: string) => {
    const input = (await screen.findByLabelText(view.i18n.t('metadata.interval'), {}, FIRST)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(String(stored.subscriptionUpdateIntervalHours ?? 24)), FIRST);
    fireEvent.change(input, { target: { value: interval } });
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
  };

  it('a panel with no settings saved yet: the defaults of the form, one change, pass the schema', async () => {
    const { api, view } = mount(<SubscriptionMetadataPage />, '/subscription/metadata', {});
    await edit(view, {}, '48');
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionUpdateIntervalHours).toBe(48);
  });

  it('every setting stored: the form restates them as they were, the request passes the schema', async () => {
    const { api, view } = mount(<SubscriptionMetadataPage />, '/subscription/metadata', SUBSCRIPTION);
    await edit(view, SUBSCRIPTION, '48');
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body).toMatchObject({ ...SUBSCRIPTION, subscriptionUpdateIntervalHours: 48 });
    sameWhereSent(body, SUBSCRIPTION, ['subscriptionUpdateIntervalHours']);
  });
});

describe('subscription metadata page, an own preset as the default (19.15)', () => {
  const OWN = { id: '6f1d1c1e-0000-4000-8000-000000000001', name: 'Team default', builtIn: false, rules: [], dnsRules: [] };

  const mountWithPresets = (stored: Record<string, unknown>) => {
    const api = installEmptyApi({
      routes: [
        { re: /^\/api\/settings$/, reply: stored },
        { re: /^\/api\/routing-presets$/, reply: { presets: [OWN] } },
      ],
      onWrite: (r) => (r.method === 'PUT' && r.url === '/api/settings' ? { data: stored } : undefined),
    });
    const view = renderWithProviders(
      <Routes>
        <Route path="/subscription/metadata" element={<SubscriptionMetadataPage />} />
      </Routes>,
      { route: '/subscription/metadata' },
    );
    return { api, view };
  };

  it('picking an own preset sends its id, which the schema accepts, and leaves the built-in key alone', async () => {
    const { api, view } = mountWithPresets(SUBSCRIPTION);
    fireEvent.click(await screen.findByText(OWN.name, {}, FIRST));
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionDefaultPresetId).toBe(OWN.id);
    // The built-in key is left as it was: it stays the default for panels that never pick an own preset.
    expect(body.subscriptionRoutingPreset).toBe('ru-split');
  });

  it('a stored own default is shown as the chosen one and is sent back unchanged', async () => {
    const stored = { ...SUBSCRIPTION, subscriptionDefaultPresetId: OWN.id };
    const { api, view } = mountWithPresets(stored);
    await screen.findByText(OWN.name, {}, FIRST);
    const input = (await screen.findByLabelText(view.i18n.t('metadata.interval'), {}, FIRST)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('12'), FIRST);
    fireEvent.change(input, { target: { value: '48' } });
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionDefaultPresetId).toBe(OWN.id);
  });
});

describe('subscription delivery page', () => {
  const STORED = {
    subscriptionDefaultFormat: 'plain',
    subscriptionLinkShape: 'per-node',
    subscriptionPublicHost: 'sub.example.test',
    subscriptionDeadTexts: { expired: { ru: 'Истекла', en: 'Expired' }, limited: { en: 'Out of traffic' } },
  };

  it.each([
    ['nothing stored', {}],
    ['every setting stored', STORED],
  ])('%s: a changed host passes the schema and the rest is as stored', async (_n, stored) => {
    const { api, view } = mount(<SubscriptionDeliveryPage />, '/subscription/metadata/delivery', stored);
    const host = (await screen.findByPlaceholderText('sub.example.com', {}, FIRST)) as HTMLInputElement;
    await waitFor(() => expect(host.value).toBe((stored as { subscriptionPublicHost?: string }).subscriptionPublicHost ?? ''), FIRST);
    fireEvent.change(host, { target: { value: 'other.example.test' } });
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionPublicHost).toBe('other.example.test');
    sameWhereSent(body, stored, ['subscriptionPublicHost']);
  });
});

describe('settings page, brand name', () => {
  it('the saved name passes the schema', async () => {
    const { api, view } = mount(<SettingsPage />, '/settings', { brandName: 'Acme' });
    const input = (await screen.findByPlaceholderText('Iceslab', {}, FIRST)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Acme'), FIRST);
    fireEvent.change(input, { target: { value: 'Acme VPN' } });
    // The page has more than one Save; the brand card's is the first.
    fireEvent.click((await screen.findAllByRole('button', { name: view.i18n.t('common.save') }))[0]!);
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body).toEqual({ brandName: 'Acme VPN' });
  });
});

describe('routes page, own rules', () => {
  const STORED = {
    subscriptionCustomDomainLists: { direct: ['example.ru'], proxy: ['youtube.com'], block: ['ads.example.com'] },
    subscriptionCustomRoutingRules: [{ type: 'field', domain: ['geosite:category-ru'], outboundTag: 'direct' }],
  };

  it('a list edited, the stored rules come back as they were', async () => {
    const { api, view } = mount(<OwnRules />, '/', STORED);
    const block = (await screen.findByPlaceholderText('ads.example.com', {}, FIRST)) as HTMLTextAreaElement;
    await waitFor(() => expect(block.value).toBe('ads.example.com'), FIRST);
    fireEvent.change(block, { target: { value: 'ads.example.com\ntracker.example.com' } });
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body).toEqual({
      subscriptionCustomDomainLists: { ...STORED.subscriptionCustomDomainLists, block: ['ads.example.com', 'tracker.example.com'] },
      subscriptionCustomRoutingRules: STORED.subscriptionCustomRoutingRules,
    });
  });

  it('all three lists emptied clear the setting with null, which the schema takes', async () => {
    const { api, view } = mount(<OwnRules />, '/', STORED);
    // The three buckets come first, the raw rules textarea last.
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(4), FIRST);
    const [direct, proxy, block] = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    await waitFor(() => expect([direct!.value, proxy!.value, block!.value]).toEqual(['example.ru', 'youtube.com', 'ads.example.com']));
    for (const box of [direct!, proxy!, block!]) fireEvent.change(box, { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionCustomDomainLists).toBeNull();
  });
});

describe('routes page, panel-wide DNS rules (stage 19)', () => {
  const DNS = [{ match: ['geosite:category-ru'], server: 'tcp://77.88.8.8', note: 'ru' }];

  it('a rule added is sent as the only key changed, and the schema takes it', async () => {
    const { api, view } = mount(<OwnRules />, '/', {});
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('routes.dnsRuleAdd') }, FIRST));
    fireEvent.change(screen.getByLabelText(view.i18n.t('routes.dnsRuleNames')), { target: { value: 'geosite:category-ru example.ru' } });
    fireEvent.change(screen.getByLabelText(view.i18n.t('routes.dnsRuleServer')), { target: { value: 'tcp://77.88.8.8' } });
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionDnsRules).toEqual([{ match: ['geosite:category-ru', 'example.ru'], server: 'tcp://77.88.8.8', note: '' }]);
  });

  it('a wrong server is marked before anything is sent and the save waits', async () => {
    const { api, view } = mount(<OwnRules />, '/', {});
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('routes.dnsRuleAdd') }, FIRST));
    fireEvent.change(screen.getByLabelText(view.i18n.t('routes.dnsRuleNames')), { target: { value: 'example.ru' } });
    fireEvent.change(screen.getByLabelText(view.i18n.t('routes.dnsRuleServer')), { target: { value: 'dns.example' } });
    expect(await screen.findByText(view.i18n.t('routes.dnsRuleBadServer', { entry: 'dns.example' }))).toBeTruthy();
    const save = (await screen.findByRole('button', { name: view.i18n.t('common.save') })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(api.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('stored rules are shown, and the last one deleted clears the setting with null', async () => {
    const { api, view } = mount(<OwnRules />, '/', { subscriptionDnsRules: DNS });
    const names = (await screen.findByLabelText(view.i18n.t('routes.dnsRuleNames'), {}, FIRST)) as HTMLInputElement;
    await waitFor(() => expect(names.value).toBe('geosite:category-ru'), FIRST);
    fireEvent.click(screen.getAllByTitle(view.i18n.t('common.delete'))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: view.i18n.t('common.save') }));
    const body = await saved(api);
    accepted(UpdateSettingsSchema, body);
    expect(body.subscriptionDnsRules).toBeNull();
  });

  it('the table of formats stands under the rules', async () => {
    const { view } = mount(<OwnRules />, '/', {});
    expect(await screen.findByRole('table', { name: view.i18n.t('routes.dnsFormat.title') }, FIRST)).toBeTruthy();
  });
});
