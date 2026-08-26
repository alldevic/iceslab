import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../test/render';
import type { Squad } from '../lib/api';

/**
 * The one screen where a form that has not caught up is worse than a form that
 * refuses.
 *
 * Every list on this page is a SET REPLACEMENT server-side: what gets sent
 * becomes the whole grant, and an empty array revokes it. A save from a form
 * still holding the previous squad's values would not fail — it would write
 * those values onto this squad, and a save from an unfilled one would strip the
 * grants and cut every member off their endpoints. The page's answer is
 * `seededId`: saving stays closed until the values on screen are this squad's
 * own, and the mutation throws as a second line if anything routes around the
 * button.
 *
 * Nothing checked either half. The case that matters most is the one the code
 * comment names outright — walking from one squad to another, where the id has
 * changed and the fields have not — because it is reachable by clicking, and
 * because HostEditPage held the same shape and was wrong about it: it re-seeded
 * on a list length instead of on the record, and threw away what had been typed.
 */

const listSquads = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  const empty = { hosts: [], bindings: [], nodes: [], profiles: [], cascades: [], policies: [] };
  return {
    ...actual,
    listSquads: () => listSquads(),
    // Everything else this page reads on mount. Left as rejections they show up
    // as an empty screen, which is indistinguishable from a broken render.
    listHosts: vi.fn(async () => ({ hosts: empty.hosts })),
    listBindings: vi.fn(async () => ({ bindings: empty.bindings })),
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    listProfiles: vi.fn(async () => ({ profiles: empty.profiles })),
    listCascades: vi.fn(async () => ({ cascades: empty.cascades })),
    listRoutePolicies: vi.fn(async () => ({ policies: empty.policies })),
  };
});

import { SquadEditPage } from './SquadEditPage';

function squad(over: Partial<Squad> & Pick<Squad, 'id' | 'name'>): Squad {
  return {
    description: null,
    profileIds: [],
    exitAcl: [],
    policyIds: [],
    hostIds: [],
    routingPreset: null,
    hwidDeviceLimit: null,
    memberCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

const ALPHA = squad({ id: 'squad-alpha', name: 'Alpha tier' });
const BETA = squad({ id: 'squad-beta', name: 'Beta tier' });

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/squads/:id" element={<SquadEditPage />} />
    </Routes>,
    { route },
  );
}

const nameField = async () => (await screen.findByLabelText(/Name/i)) as HTMLInputElement;
const saveButton = async () => screen.findByRole('button', { name: /^Save$/i });

describe('SquadEditPage refuses to save a form that is not this squad', () => {
  it('fills the form from the squad in the url', async () => {
    // The control for everything below: a page that never seeded would also
    // "not show the wrong squad".
    listSquads.mockResolvedValue({ squads: [ALPHA, BETA] });
    renderAt('/squads/squad-alpha');
    await waitFor(async () => expect((await nameField()).value).toBe('Alpha tier'));
    await waitFor(async () => expect(await saveButton()).toBeEnabled());
  });

  it('offers nothing to save until the squad has loaded', async () => {
    // Before the list resolves there is no squad, and the answer turns out to
    // be stronger than a disabled button: the form is not rendered at all, so
    // there is nothing on screen that could send a set-replacement of empty
    // lists. Asserted as what is actually there rather than as what was
    // expected to be there.
    let resolve!: (v: { squads: Squad[] }) => void;
    listSquads.mockReturnValue(new Promise((r) => (resolve = r)));
    renderAt('/squads/squad-alpha');

    await screen.findByText(/Loading/i);
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();

    resolve({ squads: [ALPHA, BETA] });
    await waitFor(async () => expect(await saveButton()).toBeEnabled());
  });

  it('says so, with a way back, when the squad in the url is gone', async () => {
    // A stale bookmark or a squad deleted from another tab. The same guard
    // covers it, and the distinction matters: "loading" and "not found" are
    // the same empty screen unless the page says which.
    listSquads.mockResolvedValue({ squads: [ALPHA] });
    renderAt('/squads/squad-that-was-deleted');

    await screen.findByText(/no longer exists|not found/i);
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();
    await screen.findByRole('button', { name: /back to squads/i });
  });

  it('shows the second squad, not the first, after walking to it', async () => {
    // The case the code comment names. Both squads are in one response, so the
    // record swaps under a mounted page with no fetch in between — exactly the
    // moment a seed keyed on anything but the record itself would miss.
    listSquads.mockResolvedValue({ squads: [ALPHA, BETA] });
    const { unmount } = renderAt('/squads/squad-alpha');
    await waitFor(async () => expect((await nameField()).value).toBe('Alpha tier'));
    unmount();

    renderAt('/squads/squad-beta');
    await waitFor(async () => expect((await nameField()).value).toBe('Beta tier'));
    // And it must be saveable again once it has caught up, or walking between
    // squads would leave the screen permanently read-only.
    await waitFor(async () => expect(await saveButton()).toBeEnabled());
  });

  /**
   * What actually keeps an unfilled form from saving, measured rather than
   * assumed.
   *
   * There are three guards for one decision: the render guard (`!squad` ->
   * the form is not drawn at all), `!seeded` on the Save button, and a throw
   * inside the mutation. Removing the SECOND one leaves every case in this
   * file green, and that is not a hole in the file — it is what the code is.
   * The form only exists once `squad` is non-null, and the seeding effect runs
   * on that same update, so `seeded` is false for one unpainted frame and
   * never for a frame anyone can click. The throw is reachable only through
   * the button, which is to say not at all.
   *
   * So the load-bearing guard is the render guard, and the other two are a
   * second and third copy of the same decision that cannot fire while the
   * first one holds. Worth keeping — they are what catches a future shape
   * where the form is drawn before the record arrives — and worth writing
   * down, because a guard nothing can reach looks identical to a guard that
   * works.
   */
  it('is protected by the render guard, not by the disabled button', async () => {
    listSquads.mockResolvedValue({ squads: [ALPHA] });
    renderAt('/squads/squad-alpha');
    // Once the form is on screen at all, it is already this squad's: there is
    // no reachable state where the fields are drawn and Save is closed.
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Alpha tier'));
    expect(await saveButton()).toBeEnabled();
  });

  it('re-seeds when the squad is saved elsewhere', async () => {
    listSquads.mockResolvedValue({ squads: [ALPHA] });
    const { queryClient } = renderAt('/squads/squad-alpha');
    await waitFor(async () => expect((await nameField()).value).toBe('Alpha tier'));

    listSquads.mockResolvedValue({
      squads: [{ ...ALPHA, name: 'Alpha renamed', updatedAt: '2026-08-27T10:00:00.000Z' }],
    });
    await queryClient.invalidateQueries({ queryKey: ['squads'] });

    await waitFor(async () => expect((await nameField()).value).toBe('Alpha renamed'));
  });
});
