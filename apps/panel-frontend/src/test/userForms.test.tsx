// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';
import { CreateUserSchema, UpdateUserSchema } from '@backend/modules/users/users.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { accepted, mountHook, sameWhereSent } from '@/test/formDrive';
import { userRecord } from '@/test/records';
import { useUserForm } from '@/contours/users/components/UserDrawer/useUserForm';
import { GiB, defaultValues, userUpdatePatch } from '@/contours/users/lib/userForm';
import type { CreateUserInput, UpdateUserInput, User } from '@/lib/domain/users';

/*
 * The user drawer against CreateUserSchema / UpdateUserSchema (milestone 17.5).
 * The hook that owns the drawer is mounted and its submit handler is called the
 * way the Save button calls it; what reaches `onSubmit` is the body the page
 * hands to the API.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const SQUAD = '11111111-1111-4111-8111-111111111111';

function open(user: User | null) {
  installEmptyApi();
  const sent: Array<CreateUserInput | UpdateUserInput> = [];
  const closed = vi.fn();
  const hook = mountHook(() =>
    useUserForm({
      opened: true,
      user,
      onClose: closed,
      onSubmit: async (input) => {
        sent.push(input);
      },
    }),
  );
  return { hook, sent, closed };
}

describe('user create drawer, username only', () => {
  it('the request the default form builds passes CreateUserSchema', async () => {
    const { hook, sent } = open(null);
    await waitFor(() => expect(hook.current.isEdit).toBe(false));
    act(() => hook.current.form.setFieldValue('username', 'alice'));
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    expect(sent).toHaveLength(1);
    const parsed = accepted(CreateUserSchema, sent[0]);
    expect(parsed.username).toBe('alice');
  });

  it('with the optional fields filled the request passes too, a built-in preset and an own one each', async () => {
    const { hook, sent } = open(null);
    act(() =>
      hook.current.form.setValues({
        username: 'bob_1',
        description: 'note',
        tag: 'vip',
        email: 'bob@example.test',
        telegramId: '12345',
        hwidDeviceLimit: 3,
        trafficLimitGb: 50,
        expireDays: 30,
        expirySet: true,
        groupIds: [SQUAD],
        routingPreset: 'ru-split',
      }),
    );
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    act(() => hook.current.form.setFieldValue('routingPreset', SQUAD));
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    expect(sent).toHaveLength(2);
    for (const body of sent) accepted(CreateUserSchema, body);
  });
});

describe('user edit drawer, opened on a stored user', () => {
  const STORED = userRecord({
    id: SQUAD,
    username: 'carol',
    status: 'active',
    trafficLimitBytes: 5 * GiB,
    trafficLimitStrategy: 'month',
    hwidDeviceLimit: 0,
    description: 'a note',
    tag: 'vip',
    email: 'carol@example.test',
    telegramId: '42',
    routingPreset: 'ru-split',
    groupIds: [SQUAD],
  });

  it('saved without an edit, sends nothing: no restated field can roll back the bot', async () => {
    const { hook, sent, closed } = open(STORED);
    await waitFor(() => expect(hook.current.form.values.username).toBe('carol'));
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    expect(sent).toEqual([]);
    expect(closed).toHaveBeenCalled();
  });

  it('with the form seeded from the record, the patch of the untouched values is empty', () => {
    expect(userUpdatePatch(defaultValues(STORED), defaultValues(STORED), null)).toEqual({});
  });

  it('changing one field sends that field alone, and the body passes UpdateUserSchema', async () => {
    const { hook, sent } = open(STORED);
    await waitFor(() => expect(hook.current.form.values.username).toBe('carol'));
    act(() => hook.current.form.setFieldValue('description', 'another note'));
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    expect(sent).toEqual([{ description: 'another note' }]);
    accepted(UpdateUserSchema, sent[0]);
  });

  it.each([
    ['status', 'disabled', { status: 'disabled' }],
    ['trafficLimitGb', 10, { trafficLimitGb: 10 }],
    ['trafficLimitGb', '', { trafficLimitGb: null }],
    ['hwidDeviceLimit', '', { hwidDeviceLimit: null }],
    ['email', '', { email: null }],
    ['telegramId', '', { telegramId: null }],
    ['routingPreset', '', { routingPreset: null }],
    ['routingPreset', SQUAD, { customRoutingPresetId: SQUAD }],
    ['groupIds', [], { groupIds: [] }],
  ] as const)('%s -> %j: the one change passes UpdateUserSchema and restates nothing else', async (field, value, expected) => {
    const { hook, sent } = open(STORED);
    await waitFor(() => expect(hook.current.form.values.username).toBe('carol'));
    act(() => hook.current.form.setFieldValue(field, value as never));
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject(expected);
    accepted(UpdateUserSchema, sent[0]);
    sameWhereSent(sent[0] as Record<string, unknown>, STORED as unknown as Record<string, unknown>, Object.keys(expected));
  });

  it.each(['d7', 'd30', 'y100', 'never'] as const)('a picked expiry (%s) goes as an ISO instant the schema takes', async (span) => {
    const { hook, sent } = open(STORED);
    await waitFor(() => expect(hook.current.form.values.username).toBe('carol'));
    act(() => hook.current.setExpiry(span));
    await act(async () => {
      await hook.current.handleSubmit(hook.current.form.values);
    });
    expect(sent).toHaveLength(1);
    accepted(UpdateUserSchema, sent[0]);
    expect(typeof (sent[0] as UpdateUserInput).expireAt === 'string' || (sent[0] as UpdateUserInput).expireAt === null).toBe(true);
  });
});
