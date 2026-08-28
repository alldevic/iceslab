import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { UpdateNodeSchema } from '../../../panel-backend/src/modules/nodes/nodes.schemas';
import { UpdateSquadSchema } from '../../../panel-backend/src/modules/squads/squads.schemas';
import { UpdateUserSchema } from '../../../panel-backend/src/modules/users/users.schemas';
import { aNode, aSquad, aUser } from '../test/records';

/**
 * Open a saved record, change nothing, press Save — and send back what was
 * there.
 *
 * `ProfileFormModal.roundtrip.test.tsx` asks this of the fourteen profile
 * kinds, where the whole config blob is replaced and the question is what
 * survives. The other three records are updated field by field under
 * `!== undefined` guards, so an OMITTED field is safe; what is not safe is a
 * field the form sends with a default instead of with the record's value. That
 * is the shape §51 found in the node form and §57 found again here.
 *
 * Every payload key is compared against the record, and the whole payload is
 * handed to the API's own update schema — imported, not restated.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    listProfiles: vi.fn(async () => ({ profiles: [] })),
    listSquads: vi.fn(async () => ({ squads: [] })),
    listBindings: vi.fn(async () => ({ bindings: [] })),
    listHosts: vi.fn(async () => ({ hosts: [] })),
    listRegions: vi.fn(async () => ({ regions: [] })),
    listUserTags: vi.fn(async () => ({ tags: [] })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
  };
});

import { NodeEditModal } from './NodeEditModal';
import { SquadFormModal } from './SquadFormModal';
import { UserDrawer } from './UserDrawer';

interface Schema {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
}

/** The payload of the one submit that happened, once the API accepts it. */
async function saved(onSubmit: ReturnType<typeof vi.fn>, schema: Schema, argIndex = 0) {
  await waitFor(() => {
    if (onSubmit.mock.calls.length === 1) return;
    const said = Array.from(document.querySelectorAll('.mantine-InputWrapper-error'))
      .map((el) => el.textContent)
      .filter(Boolean);
    throw new Error(
      `the form refused to re-save a record it had just been handed${said.length ? `: ${said.join(' | ')}` : ' and said nothing about why'}`,
    );
  });
  const payload = (onSubmit.mock.calls as unknown[][])[0][argIndex] as Record<string, unknown>;
  const parsed = schema.safeParse(payload);
  expect(
    parsed.success ? [] : parsed.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    `the API refuses what this form sent back: ${JSON.stringify(payload)}`,
  ).toEqual([]);
  return payload;
}

describe('an edit form sends back the record it was given', () => {
  it('node: every field the modal submits still holds what the node held', async () => {
    const node = aNode({
      name: 'ams-1',
      address: '203.0.113.10:1337',
      protocol: 'hysteria',
      countryCode: 'NL',
      consumptionMultiplier: '3',
      maxUsers: 250,
      domain: 'des-01.example.com',
      status: 'online',
      // The blob no control draws in full: the wizard renders three of its
      // keys and has to carry the rest untouched.
      hardening: {
        ufwLockdown: true,
        fail2ban: true,
        sshAllowlist: ['203.0.113.9'],
        pool: { asn: 'AS64500', provider: 'probe-host' },
      },
    });
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <NodeEditModal
        opened
        onClose={() => {}}
        node={node}
        saving={false}
        refreshing={false}
        onSubmit={onSubmit}
        onDelete={() => {}}
        onRefreshBootstrap={() => {}}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    const p = await saved(onSubmit, UpdateNodeSchema);

    expect(p.name).toBe(node.name);
    expect(p.address).toBe(node.address);
    expect(p.protocol).toBe(node.protocol);
    expect(p.countryCode).toBe(node.countryCode);
    expect(p.consumptionMultiplier).toBe(Number(node.consumptionMultiplier));
    expect(p.maxUsers).toBe(node.maxUsers);
    expect(p.regionId).toBe(node.regionId);
    expect(p.domain).toBe(node.domain);
    expect(p.status).toBe('active');
    expect(p.hardening, 'the wizard dropped the keys it does not draw').toEqual(node.hardening);
  });

  it('squad: a rename reaches the payload, and nothing else moves', async () => {
    // Renaming is the case, not an incidental one: the re-seed used to be keyed
    // on `form.values.name !== squad.name`, so typing into Name made the
    // condition true and the next render put the old name back. A squad could
    // not be renamed here at all, and every other field edited in the same
    // session was reset with it.
    const squad = aSquad({
      name: 'Standard',
      description: 'the paying tier',
      routingPreset: 'ru-split',
      hwidDeviceLimit: 3,
      profileIds: ['11111111-1111-4111-8111-111111111111'],
      policyIds: ['22222222-2222-4222-8222-222222222222'],
    });
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <SquadFormModal
        opened
        onClose={() => {}}
        squad={squad}
        profiles={[]}
        onSubmit={onSubmit}
        loading={false}
      />,
    );

    const name = screen.getByLabelText(/^Name/i) as HTMLInputElement;
    expect(name.value, 'the form did not seed from the squad').toBe('Standard');
    await user.clear(name);
    await user.click(name);
    await user.paste('Standard-renamed');
    expect(
      (screen.getByLabelText(/^Name/i) as HTMLInputElement).value,
      'the form put the old name back while the operator was typing',
    ).toBe('Standard-renamed');

    await user.click(screen.getByRole('button', { name: /^Save/ }));
    const p = await saved(onSubmit, UpdateSquadSchema);

    expect(p.name).toBe('Standard-renamed');
    expect(p.description).toBe(squad.description);
    expect(p.routingPreset).toBe(squad.routingPreset);
    expect(p.hwidDeviceLimit).toBe(squad.hwidDeviceLimit);
    expect(p.profileIds).toEqual(squad.profileIds);
    expect(p.policyIds).toEqual(squad.policyIds);
  });

  it('user: every field the drawer submits still holds what the user held', async () => {
    const user0 = aUser({
      status: 'disabled',
      description: 'a note',
      tag: 'VIP',
      email: 'buyer@example.com',
      telegramId: '123456789',
      hwidDeviceLimit: 2,
      trafficLimitBytes: 50 * 1024 ** 3,
      trafficLimitStrategy: 'month',
      routingPreset: 'ru-split',
      groupIds: ['33333333-3333-4333-8333-333333333333'],
    });
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <UserDrawer opened onClose={() => {}} user={user0} onSubmit={onSubmit} loading={false} />,
    );
    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    const p = await saved(onSubmit, UpdateUserSchema);

    // `status` must not be in the payload at all: the drawer draws no control
    // for it. It used to send `active` for anything that was not `disabled`, so
    // saving an unrelated field on a lapsed user handed their access back.
    expect(Object.keys(p), 'the drawer sent a field it draws no control for').not.toContain(
      'status',
    );
    expect(p.description).toBe(user0.description);
    expect(p.tag).toBe(user0.tag);
    expect(p.email).toBe(user0.email);
    expect(p.telegramId).toBe(user0.telegramId);
    expect(p.hwidDeviceLimit).toBe(user0.hwidDeviceLimit);
    expect(p.trafficLimitGb).toBe(50);
    expect(p.trafficLimitStrategy).toBe(user0.trafficLimitStrategy);
    expect(p.routingPreset).toBe(user0.routingPreset);
    expect(p.groupIds).toEqual(user0.groupIds);
  });

  it('user: a lapsed subscriber is not reactivated by an edit to something else', async () => {
    // The case that matters, and the one a `disabled` fixture cannot show: a
    // user the cron put in `expired`. The drawer has no status control, so any
    // status in the payload is one nobody asked for.
    const user0 = aUser({ status: 'expired', description: 'a note' });
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <UserDrawer opened onClose={() => {}} user={user0} onSubmit={onSubmit} loading={false} />,
    );
    await user.click(await screen.findByRole('button', { name: /^Save/ }));
    const p = await saved(onSubmit, UpdateUserSchema);
    expect(
      p.status,
      'editing a lapsed subscriber handed them their access back until the next cron tick',
    ).toBeUndefined();
  });

  it('node: a background refetch of the same record does not wipe an edit in progress', async () => {
    // The seed key, asked of the modal the way NodeEditPage.seed.test.tsx asks
    // it of the page. It was keyed on the node OBJECT, so React Query handing
    // down an equal-but-new object re-seeded the form over what the operator was
    // typing — measured: "ams-1-edge" read back as "ams-1".
    //
    // Latent rather than live in today's app, because NodesPage holds the node
    // being edited in useState and the identity is stable while the modal is
    // open. Closed anyway: it is one line, and the page behind /nodes/:id keys
    // on the id for exactly this reason.
    const node = aNode({ name: 'ams-1' });
    const props = {
      opened: true,
      onClose: () => {},
      saving: false,
      refreshing: false,
      onSubmit: vi.fn(async () => {}),
      onDelete: () => {},
      onRefreshBootstrap: () => {},
    };
    const { user, rerender } = renderWithProviders(<NodeEditModal {...props} node={node} />);
    const name = () => screen.getByLabelText(/^Name/i) as HTMLInputElement;
    await user.clear(name());
    await user.click(name());
    await user.paste('ams-1-edge');
    expect(name().value, 'the control never took the edit').toBe('ams-1-edge');

    rerender(<NodeEditModal {...props} node={{ ...node }} />);
    expect(name().value, 'a refetch of identical data threw away the edit').toBe('ams-1-edge');
  });
});
