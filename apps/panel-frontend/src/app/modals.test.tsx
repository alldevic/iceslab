// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { PROTOCOL_NAMES } from '@iceslab/shared';
import { installEmptyApi, type LoggedRequest } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { createI18n, missingKeys, renderWithProviders } from '@/test/render';
import {
  geoSetRecord,
  nodePolicyRecord,
  profileRecord,
  routePolicyRecord,
  routingPresetRecord,
  userRecord,
} from '@/test/records';
import type { InboundConfig } from '@/lib/domain/inbounds';
import { caught, textProblems, visibleText, type KnownException } from '@/test/screens';
import { NodePayloadModal } from '@/contours/nodes/components/NodePayloadModal';
import { DeployProfileModal } from '@/contours/profiles/components/DeployProfileModal';
import { ProfileFormModal } from '@/contours/profiles/components/ProfileFormModal';
import { ProfileRecipeExportModal } from '@/contours/profiles/components/ProfileRecipeExportModal';
import { RecipeExportModal } from '@/contours/profiles/components/RecipeExportModal';
import { RecipePicker } from '@/contours/profiles/components/RecipePicker';
import { TestConnectModal } from '@/contours/profiles/components/TestConnectModal';
import { GeoRolloutModal } from '@/contours/traffic/components/GeoRolloutModal';
import { UserDrawer } from '@/contours/users/components/UserDrawer';
import { RoutePolicyEditor } from '@/contours/traffic/components/RoutePolicyEditor';
import { DevicePresetEditor } from '@/contours/traffic/components/DevicePresetEditor';
import { NodePolicyEditor } from '@/contours/traffic/components/NodePolicy/NodePolicyEditor';
import { SettingsPage } from '@/contours/settings/screens/SettingsPage';

/*
 * Every modal, drawer and record editor of the panel, opened (the `opened`
 * prop, not a click) on a minimal record or none, in English, on an empty
 * panel: no render error, no Cyrillic, no raw locale key, nothing requested
 * that the empty-panel fixture does not describe.
 *
 * Completeness is by source: every file under `src` that contains `<Modal` or
 * `<Drawer` must be `covers`-ed by a row, so a new dialog fails here until a
 * row opens it. The two dialogs inside SettingsPage are not exported, so they
 * are opened the way an operator opens them, with `fireEvent`.
 */

const noop = () => {};

interface ModalCase {
  name: string;
  /** Files (relative to `src/`) holding the `<Modal`/`<Drawer` this row opens. */
  covers: string[];
  element: () => ReactNode;
  /** Dictionary key of a phrase the open dialog shows, with interpolation values. */
  phrase: [key: string, values?: Record<string, unknown>];
  /** Answers to writes the dialog makes on open, so the log stays free of refusals. */
  onWrite?: (req: LoggedRequest) => { data: unknown } | undefined;
}

const MODALS: ModalCase[] = [
  {
    name: 'node payload',
    covers: ['contours/nodes/components/NodePayloadModal.tsx'],
    element: () => <NodePayloadModal opened onClose={noop} nodeName="n1" payload="abc" />,
    phrase: ['nodePayloadModal.title', { name: 'n1' }],
  },
  {
    name: 'deploy profile',
    covers: ['contours/profiles/components/DeployProfileModal.tsx'],
    element: () => <DeployProfileModal profile={profileRecord()} onClose={noop} />,
    phrase: ['profiles.deploy.title', { name: 'min-profile' }],
  },
  {
    name: 'profile form, new',
    covers: ['contours/profiles/components/ProfileForm/FormShell.tsx'],
    element: () => <ProfileFormModal opened onClose={noop} profile={null} onSubmit={async () => {}} />,
    phrase: ['modal.profileNewTitle'],
  },
  {
    name: 'profile form, edit',
    covers: ['contours/profiles/components/ProfileForm/FormShell.tsx'],
    element: () => <ProfileFormModal opened onClose={noop} profile={profileRecord()} onSubmit={async () => {}} />,
    phrase: ['modal.profileEditSubtitle'],
  },
  // One form per protocol the contract names, so a new protocol is opened
  // here without a row (WireGuard, the MTProto engine choice, AmneziaWG
  // generations are sections of this form).
  ...PROTOCOL_NAMES.map(
    (protocol): ModalCase => ({
      name: `profile form, edit, ${protocol}`,
      covers: [],
      element: () => (
        <ProfileFormModal
          opened
          onClose={noop}
          profile={profileRecord({ protocol, config: {} as InboundConfig, effectiveEngine: 'xray' })}
          onSubmit={async () => {}}
        />
      ),
      phrase: ['modal.profileEditSubtitle'],
    }),
  ),
  {
    name: 'saved profile as recipe',
    covers: ['contours/profiles/components/ProfileRecipeExportModal.tsx'],
    element: () => <ProfileRecipeExportModal opened onClose={noop} profileId="p1" />,
    phrase: ['recipes.export.title'],
  },
  {
    name: 'form values as recipe',
    covers: ['contours/profiles/components/RecipeExportModal.tsx'],
    element: () => <RecipeExportModal opened onClose={noop} protocol="xray" values={{}} />,
    phrase: ['recipes.export.hint'],
  },
  {
    name: 'recipe picker',
    covers: ['contours/profiles/components/RecipePicker.tsx'],
    element: () => <RecipePicker kindKey="xray-vless-reality" kindLabel="x" protocol="xray" onPick={noop} />,
    phrase: ['recipes.title'],
  },
  {
    name: 'connection test',
    covers: ['contours/profiles/components/TestConnectModal.tsx'],
    element: () => <TestConnectModal profile={profileRecord()} onClose={noop} />,
    phrase: ['testConnect.title'],
    // The probe starts on open: a POST, answered with no bindings to probe.
    onWrite: (r) => (/^\/api\/profiles\/[^/]+\/test-connect$/.test(r.url) ? { data: { results: [] } } : undefined),
  },
  {
    name: 'geo set rollout',
    covers: ['contours/traffic/components/GeoRolloutModal.tsx'],
    element: () => <GeoRolloutModal set={geoSetRecord()} onClose={noop} />,
    phrase: ['geoSets.rollout.title', { name: 'min-set' }],
  },
  {
    name: 'user drawer, new',
    covers: ['contours/users/components/UserDrawer.tsx'],
    element: () => <UserDrawer opened onClose={noop} user={null} onSubmit={async () => {}} />,
    phrase: ['userDrawer.newTitle'],
  },
  {
    name: 'user drawer, existing (devices, WireGuard devices)',
    covers: ['contours/users/components/UserDrawer.tsx'],
    element: () => <UserDrawer opened onClose={noop} user={userRecord()} onSubmit={async () => {}} />,
    phrase: ['userDrawer.editSubtitle'],
  },
  // Editors that are not dialogs but take a record: a page reaches them only
  // after a click or a record the empty panel does not have.
  {
    name: 'route policy editor',
    covers: [],
    element: () => <RoutePolicyEditor policy={routePolicyRecord()} squads={[]} onOpenNodePolicies={noop} />,
    phrase: ['routes.blockAboveDirect'],
  },
  {
    name: 'device preset editor',
    covers: [],
    element: () => <DevicePresetEditor preset={routingPresetRecord()} isDefault={false} />,
    phrase: ['routes.presetNoRules'],
  },
  {
    name: 'node policy editor',
    covers: [],
    element: () => (
      <NodePolicyEditor policy={nodePolicyRecord()} directions={[]} isDraft={false} onSaved={noop} onDeleted={noop} />
    ),
    phrase: ['routes.nodeNoRules'],
  },
];

/** Dialogs inside a screen, opened by clicking: see the cases at the end. */
const INSIDE_SCREENS = ['contours/settings/screens/SettingsPage.tsx'];

/** Defects found by mounting that are not fixed in this milestone: by row, with the task that owns each. None today. */
const KNOWN_EXCEPTIONS: KnownException[] = [];

const sources = import.meta.glob('/src/**/*.tsx', { query: '?raw', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

const en = createI18n('en');

beforeAll(() => installJsdomStubs());
afterEach(cleanup);

function judge(name: string, api: ReturnType<typeof installEmptyApi>) {
  const text = visibleText(document.body, '\n');
  expect(caught, 'render error caught by the boundary').toBeNull();
  api.assertNoUnknown();
  expect(text).not.toContain(en.t('common.loadFailed'));
  expect(missingKeys, 'keys the en dictionary lacks').toEqual([]);
  expect(textProblems(name, text, KNOWN_EXCEPTIONS)).toEqual([]);
}

describe('modals and editors on an empty panel', () => {
  it('every file with a <Modal or <Drawer is covered by a row', { timeout: 30_000 }, async () => {
    const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx$/.test(path));
    const found = await Promise.all(files.map(async ([path, load]) => (/<(Modal|Drawer)\b/.test(await load()) ? path : null)));
    const withDialog = found.filter((p): p is string => p !== null).map((p) => p.replace('/src/', ''));
    const covered = [...MODALS.flatMap((m) => m.covers), ...INSIDE_SCREENS];
    expect(withDialog.sort()).toEqual([...new Set(covered)].sort());
  });

  describe.each(MODALS)('$name', (row) => {
    it('opens, nothing raw', { timeout: 20_000 }, async () => {
      const api = installEmptyApi({ onWrite: row.onWrite });
      renderWithProviders(row.element());

      const [key, values] = row.phrase;
      const expected = en.t(key, values);
      expect(expected, `the table names a key en lacks: ${key}`).not.toBe(key);
      await waitFor(() => expect(visibleText(document.body)).toContain(expected), { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 50));
      judge(row.name, api);
    });
  });

  describe('dialogs inside SettingsPage', () => {
    const open = async (onWrite?: (r: LoggedRequest) => { data: unknown } | undefined) => {
      const api = installEmptyApi({ onWrite });
      renderWithProviders(
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>,
        { route: '/settings' },
      );
      fireEvent.click(await screen.findByText(en.t('settings.tokens.createButton')));
      return api;
    };

    it('new API token, then the reveal of its plaintext', { timeout: 20_000 }, async () => {
      const api = await open((r) =>
        r.method === 'POST' && r.url === '/api/api-tokens'
          ? { data: { id: 't1', name: 'ci', scopes: [], lastUsedAt: null, createdAt: '1970-01-01T00:00:00.000Z', token: 'icp_test' } }
          : undefined,
      );
      await screen.findByText(en.t('settings.tokens.modalTitle'));
      judge('settings: new API token', api);

      fireEvent.change(screen.getByPlaceholderText(en.t('settings.tokens.modalNamePlaceholder')), { target: { value: 'ci' } });
      fireEvent.click(screen.getByText(en.t('settings.tokens.modalSubmit')));
      await screen.findByText(en.t('settings.tokens.revealTitle'));
      await screen.findByText('icp_test');
      judge('settings: token reveal', api);
      expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/api-tokens']);
    });
  });
});
