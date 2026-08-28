import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { CreateNodeSchema } from '../../../panel-backend/src/modules/nodes/nodes.schemas';
import { CreateSquadSchema } from '../../../panel-backend/src/modules/squads/squads.schemas';
import { CreateUserSchema } from '../../../panel-backend/src/modules/users/users.schemas';

/**
 * The same question `ProfileFormModal.defaults.test.tsx` asks of the fourteen
 * profile kinds, asked of the other three things an operator creates: a node,
 * a squad and a user. Fill only what the operator must supply, press Create,
 * and hand what the form built to the API's own create schema.
 *
 * Until this file the whole frontend suite contained exactly ONE test that
 * typed into a control and pressed a button, so "the form builds a request the
 * API accepts" was never checked anywhere except for AmneziaWG - where it had
 * already been false once (§49).
 *
 * The schemas are imported, not restated: a fixture repeating their rules would
 * be a second copy of the contract and would go stale in the one direction that
 * hides the bug.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    listProfiles: vi.fn(async () => ({ profiles: [] })),
    listSquads: vi.fn(async () => ({ squads: [] })),
    listUserTags: vi.fn(async () => ({ tags: [] })),
    getRecipeRegistry: vi.fn(async () => ({ recipes: [], stale: false })),
  };
});

import { NodeFormModal } from './NodeFormModal';
import { SquadFormModal } from './SquadFormModal';
import { UserDrawer } from './UserDrawer';

type User = ReturnType<typeof renderWithProviders>['user'];

async function paste(user: User, el: HTMLElement, value: string): Promise<void> {
  await user.clear(el);
  await user.click(el);
  await user.paste(value);
}

interface Schema {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
}

/**
 * Assert the form submitted, and that the API would take what it built.
 *
 * A refusal by the form's own validators looks like "nothing happened", so the
 * messages are read back off the screen rather than reported as a call count.
 */
async function expectAccepted(
  onSubmit: ReturnType<typeof vi.fn>,
  schema: Schema,
): Promise<void> {
  await waitFor(() => {
    if (onSubmit.mock.calls.length === 1) return;
    const said = Array.from(document.querySelectorAll('.mantine-InputWrapper-error'))
      .map((el) => el.textContent)
      .filter(Boolean);
    throw new Error(
      `the form refused to save its own defaults${said.length ? `: ${said.join(' | ')}` : ' and said nothing about why'}`,
    );
  });
  const payload = (onSubmit.mock.calls as unknown[][])[0][0];
  const parsed = schema.safeParse(payload);
  expect(
    parsed.success
      ? []
      : parsed.error!.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    `the API refuses what this form built: ${JSON.stringify(payload)}`,
  ).toEqual([]);
}

describe('a create form builds a request the API accepts', () => {
  it('node: a name and an address, everything else defaulted', async () => {
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <NodeFormModal opened onClose={() => {}} node={null} onSubmit={onSubmit} loading={false} />,
    );
    await paste(user, screen.getByLabelText(/^Name/i), 'probe-node');
    await paste(user, screen.getByLabelText(/^Address/i), 'node.example.com');
    // Registering a node is a two-step wizard; step 2 picks profiles to
    // auto-deploy and none is a legitimate answer.
    await user.click(screen.getByRole('button', { name: /Next: pick profiles/ }));
    await user.click(await screen.findByRole('button', { name: /^Create|^Register/ }));
    await expectAccepted(onSubmit, CreateNodeSchema);
  });

  it('squad: a name, everything else defaulted', async () => {
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <SquadFormModal
        opened
        onClose={() => {}}
        squad={null}
        profiles={[]}
        onSubmit={onSubmit}
        loading={false}
      />,
    );
    await paste(user, screen.getByLabelText(/^Name/i), 'probe-squad');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await expectAccepted(onSubmit, CreateSquadSchema);
  });

  it('user: a username, everything else defaulted', async () => {
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <UserDrawer opened onClose={() => {}} user={null} onSubmit={onSubmit} loading={false} />,
    );
    // This drawer draws its labels as styled text rather than <label>, so the
    // username box has no accessible name and `getByLabelText` cannot see it.
    // The placeholder is the only handle it offers - noted here rather than
    // worked around silently, because it is also what a screen reader gets.
    await paste(user, screen.getByPlaceholderText('kate_m'), 'probeuser');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await expectAccepted(onSubmit, CreateUserSchema);
  });
});
