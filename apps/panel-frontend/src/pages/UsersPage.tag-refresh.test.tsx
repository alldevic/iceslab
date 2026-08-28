import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { emptyApiModule } from '../test/emptyApi';
import type { CreateUserInput, User } from '../lib/api';

/**
 * What the tag filter knows after the operator creates a user with a new tag.
 *
 * `['user-tags']` feeds the Filters popover and is cached for five minutes.
 * Nothing in the application invalidated it — not one of the six user
 * mutations, not the manual refresh button, nowhere. So the tag an operator
 * had just typed was not offered as a filter until the cache lapsed, and the
 * tag of the last user carrying it stayed on the list, offering a filter that
 * matches nobody.
 *
 * This is also the first test in this app that FILLS A FORM. Forty-five screens
 * mount, all of them empty and untouched; the write path they exist for was
 * exercised by none of them, and the defect above lives exactly there — in what
 * happens after a submit resolves.
 */

const createUser = vi.fn(async (input: CreateUserInput): Promise<User> => ({
  id: 'u-1',
  username: input.username,
  status: 'active',
  tag: input.tag ?? null,
  subscriptionToken: 'tok',
  usedTrafficBytes: 0,
  trafficLimitBytes: null,
  trafficLimitStrategy: 'no_reset',
  expireAt: null,
  description: null,
  email: null,
  telegramId: null,
  hwidDeviceLimit: null,
  groupIds: [],
  routingPreset: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
} as unknown as User));

/** Answers with the tag only AFTER the user carrying it exists, which is the
 *  whole question: a stale cache would render the first answer forever. */
let created = false;
const listUserTags = vi.fn(async () => ({ tags: created ? ['fresh-tag'] : [] }));

vi.mock('../lib/api', async (importOriginal) =>
  emptyApiModule(await importOriginal<Record<string, unknown>>(), {
    listUserTags: (...a: unknown[]) => listUserTags(...(a as [])),
    createUser: (input: CreateUserInput) => {
      created = true;
      return createUser(input);
    },
  }),
);

import { UsersPage } from './UsersPage';

describe('creating a user with a new tag', () => {
  it('refreshes the tag list the filter is built from', async () => {
    const { user } = renderWithProviders(<UsersPage />);
    await waitFor(() => expect(listUserTags).toHaveBeenCalled());
    const firstCalls = listUserTags.mock.calls.length;

    // Open the drawer, reveal the advanced section the tag lives in, fill the
    // two fields that matter, submit.
    await user.click(await screen.findByRole('button', { name: /create user/i }));
    // By placeholder, not by label: the username field is a bare <input> under
    // a styled Box, so nothing associates the word "Username" with it. That is
    // the app-wide a11y state (§53 measured 130 literal labels against 16
    // roles) and a recorded product decision, not this test's business.
    await user.type(await screen.findByPlaceholderText('kate_m'), 'buyer-9');
    await user.click(await screen.findByText(/^show$/i));
    await user.type(await screen.findByLabelText(/^tag$/i), 'fresh-tag');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(createUser).toHaveBeenCalledTimes(1));
    // The control on the fixture: the form really carried the tag through, so
    // the refetch below is about the cache and not about an empty submit.
    expect(createUser.mock.calls[0]![0]).toMatchObject({ username: 'buyer-9', tag: 'fresh-tag' });

    await waitFor(() => expect(listUserTags.mock.calls.length).toBeGreaterThan(firstCalls));
    expect((await listUserTags.mock.results.at(-1)!.value).tags).toContain('fresh-tag');
  });
});
