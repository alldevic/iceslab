// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import { cleanup, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { createI18n, missingKeys, renderWithProviders } from '@/test/render';
import { caught, textProblems, visibleText, type KnownException } from '@/test/screens';

/*
 * Every screen of the panel, mounted on a panel with nothing in it (no node,
 * user, profile, squad, host) through its own route, in English. Each must:
 * render without a boundary catching anything; make at least one request of its
 * own; show its own empty-state phrase, read from the `en` dictionary by key;
 * ask nothing the empty-panel fixture does not describe; show no Cyrillic
 * (except the language switch) and no raw locale key.
 *
 * The table is closed: a `*Page.tsx` in the `screens` folder of any contour that is
 * not in it fails the completeness case below, so a new screen is mounted
 * before it is merged, not after the first operator opens it.
 */

interface PageCase {
  /** `<contour>/<File>`: the screen file, `src/contours/<contour>/screens/<File>.tsx`. */
  file: string;
  /** The route pattern of `app/App.tsx` the screen is mounted under. */
  route: string;
  /** The address opened; params of `route` get their values here. */
  url: string;
  /** Dictionary key of a phrase the empty screen shows,. */
  phrase: string;
  /** What the case is: a list on an empty panel, or an edit screen for a record that is not there. */
  note?: string;
}

const PAGES: PageCase[] = [
  { file: 'dashboard/DashboardPage', route: '/', url: '/', phrase: 'dashboard.nodes.empty' },
  { file: 'dashboard/InsightsPage', route: '/insights', url: '/insights', phrase: 'insights.noRequests' },
  { file: 'users/UsersPage', route: '/users', url: '/users', phrase: 'users.emptyTitle' },
  { file: 'nodes/NodesPage', route: '/nodes', url: '/nodes', phrase: 'fleetEmpty.nodesBlankTitle' },
  { file: 'nodes/NodeCreatePage', route: '/nodes/new', url: '/nodes/new', phrase: 'nodeCreate.title' },
  { file: 'nodes/NodeEditPage', route: '/nodes/:id', url: '/nodes/missing', phrase: 'nodeEdit.notFound', note: 'no such record' },
  { file: 'cascades/CascadeCreatePage', route: '/nodes/cascades/new', url: '/nodes/cascades/new', phrase: 'cascadeCreate.title' },
  { file: 'cascades/CascadeEditPage', route: '/nodes/cascades/:id', url: '/nodes/cascades/missing', phrase: 'cascadeEdit.gone', note: 'no such record' },
  { file: 'profiles/ProfilesPage', route: '/profiles', url: '/profiles', phrase: 'profiles.emptyTitle' },
  { file: 'profiles/ProfileEditPage', route: '/profiles/:id', url: '/profiles/missing', phrase: 'profileEdit.notFound', note: 'no such record' },
  { file: 'squads/SquadsPage', route: '/squads', url: '/squads', phrase: 'squads.empty' },
  { file: 'squads/SquadEditPage', route: '/squads/:id', url: '/squads/missing', phrase: 'squadEdit.notFound', note: 'no such record' },
  { file: 'hosts/HostsPage', route: '/hosts', url: '/hosts', phrase: 'hostsPage.empty' },
  { file: 'hosts/HostEditPage', route: '/hosts/:id', url: '/hosts/missing', phrase: 'hostEdit.notFound', note: 'no such record' },
  { file: 'login/LoginPage', route: '/login', url: '/login', phrase: 'loginPage.topbarStatusNormal', note: 'the health probe answered' },
  { file: 'audit/AuditPage', route: '/audit', url: '/audit', phrase: 'audit.emptyFiltered' },
  { file: 'traffic/RoutesPage', route: '/subscription/routes', url: '/subscription/routes', phrase: 'routes.nodeNoPolicies' },
  { file: 'traffic/GeoSetsPage', route: '/traffic/geo-sets', url: '/traffic/geo-sets', phrase: 'geoSets.emptyTitle' },
  { file: 'nodes/DnsPage', route: '/traffic/dns', url: '/traffic/dns', phrase: 'dnsPage.emptyTitle' },
  { file: 'traffic/NamedOutboundsPage', route: '/traffic/named-outbounds', url: '/traffic/named-outbounds', phrase: 'namedOutbounds.emptyTitle' },
  { file: 'settings/SettingsPage', route: '/settings', url: '/settings', phrase: 'settings.tokens.empty' },
  { file: 'subscription/SrrPage', route: '/subscription/delivery', url: '/subscription/delivery', phrase: 'delivery.empty' },
  { file: 'subscription/SrrRulePage', route: '/subscription/delivery/new', url: '/subscription/delivery/new', phrase: 'delivery.newTitle', note: 'new rule, with the WireGuard kind of the format list' },
  { file: 'subscription/SrrRulePage', route: '/subscription/delivery/:id', url: '/subscription/delivery/missing', phrase: 'delivery.gone', note: 'no such record' },
  { file: 'subscription/SubscriptionMetadataPage', route: '/subscription/metadata', url: '/subscription/metadata', phrase: 'metadata.headersTitle', note: 'with the Entry pool field' },
  { file: 'subscription/SubscriptionDeliveryPage', route: '/subscription/metadata/delivery', url: '/subscription/metadata/delivery', phrase: 'deliverySetup.subtitle' },
  { file: 'subscription/TemplatesPage', route: '/subscription/templates', url: '/subscription/templates', phrase: 'templates.emptyTitle' },
  { file: 'subscription/TemplateEditPage', route: '/subscription/templates/new', url: '/subscription/templates/new', phrase: 'templates.newTitle' },
  { file: 'subscription/TemplateEditPage', route: '/subscription/templates/:id', url: '/subscription/templates/missing', phrase: 'templates.gone', note: 'no such record' },
];

/** Screens whose empty state needs no request of their own. None today. */
const NEEDS_NO_REQUEST = new Set<string>();

/** Defects found by mounting that are not fixed in this milestone: by row, with the task that owns each. None today. */
const KNOWN_EXCEPTIONS: KnownException[] = [];

const modules = import.meta.glob('/src/contours/*/screens/*Page.tsx');

/** `useUsersPage.tsx` ends in `Page.tsx` and is a hook, not a screen. */
const isScreenFile = (path: string) => !/\/use[A-Z][^/]*$/.test(path);

const en_ = createI18n('en');
const phrase = (key: string) => {
  const text = en_.t(key);
  if (text === key) throw new Error(`the table names a key the en dictionary lacks: ${key}`);
  return text;
};

beforeAll(() => installJsdomStubs());
afterEach(cleanup);

describe('pages on an empty panel', () => {
  it('the table lists exactly the screen files of the contours', () => {
    const onDisk = Object.keys(modules)
      .filter(isScreenFile)
      .map((p) => p.replace('/src/contours/', '').replace('/screens/', '/').replace(/\.tsx$/, ''))
      .sort();
    expect([...new Set(PAGES.map((p) => p.file))].sort()).toEqual(onDisk);
  });

  it('every row names a phrase that exists in en', () => {
    for (const p of PAGES) expect(() => phrase(p.phrase), p.url).not.toThrow();
  });

  describe.each(PAGES)('$url ($file)', (row) => {
    it('mounts, asks the API, shows its empty state, nothing raw', { timeout: 20_000 }, async () => {
      const api = installEmptyApi();
      const [contour, name] = row.file.split('/');
      const mod = (await modules[`/src/contours/${contour}/screens/${name}.tsx`]()) as Record<string, ComponentType>;
      const Screen = mod[name];
      expect(Screen, `${row.file} exports ${name}`).toBeTypeOf('function');

      const view = renderWithProviders(
        <Routes>
          <Route path={row.route} element={<Screen />} />
        </Routes>,
        { route: row.url },
      );

      await waitFor(() => expect(visibleText(view.container)).toContain(phrase(row.phrase)), { timeout: 8000 });
      // Let the requests the first answers trigger settle before the text is judged.
      await new Promise((r) => setTimeout(r, 50));
      const text = visibleText(view.container, '\n');

      expect(caught, 'render error caught by the boundary').toBeNull();
      api.assertNoUnknown();
      if (!NEEDS_NO_REQUEST.has(row.file)) expect(api.gets().length, 'the screen made no request').toBeGreaterThan(0);
      expect(text).not.toContain(en_.t('common.loadFailed'));
      expect(missingKeys, 'keys the en dictionary lacks').toEqual([]);
      expect(textProblems(row.url, text, KNOWN_EXCEPTIONS)).toEqual([]);
    });
  });
});
