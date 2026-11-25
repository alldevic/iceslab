// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/test/queryWrapper';

const api = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listUserTags: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  resetUserTraffic: vi.fn(),
  revokeUserSubscription: vi.fn(),
  rotateUserSubscription: vi.fn(),
  bulkUsers: vi.fn(),
}));

vi.mock('@/lib/domain/users', async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock('@/lib/domain/squads', () => ({ listSquads: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/auth/api', () => ({ fetchAuthStatus: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/domain/dashboard', () => ({ useOverview: () => ({ data: undefined }) }));
vi.mock('@/lib/ui/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { useUsersPage } from '@/contours/users/screens/useUsersPage';

beforeEach(() => {
  vi.clearAllMocks();
  api.listUsers.mockResolvedValue({ users: [], total: 0 });
  api.listUserTags.mockResolvedValue({ tags: ['vip'] });
  for (const k of ['createUser', 'updateUser', 'deleteUser', 'resetUserTraffic', 'revokeUserSubscription', 'rotateUserSubscription']) {
    api[k as keyof typeof api]!.mockResolvedValue({});
  }
  api.bulkUsers.mockResolvedValue({ results: [] });
});

describe('the users page refreshes the tag list after a write', () => {
  const cases: [string, (p: ReturnType<typeof useUsersPage>) => void][] = [
    ['create', (p) => p.createMutation.mutate({} as never)],
    ['update', (p) => p.updateMutation.mutate({ id: 'u1', input: {} })],
    ['delete', (p) => p.deleteMutation.mutate('u1')],
    ['revoke', (p) => p.revokeMutation.mutate('u1')],
    ['rotate', (p) => p.rotateMutation.mutate('u1')],
    ['reset traffic', (p) => p.resetTrafficMutation.mutate('u1')],
    ['bulk', (p) => p.bulkMutation.mutate({ ids: ['u1'], action: 'enable' } as never)],
  ];

  it.each(cases)('after %s the user-tags query runs again', async (_name, run) => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useUsersPage(), { wrapper });
    await waitFor(() => expect(api.listUserTags).toHaveBeenCalledTimes(1));

    act(() => run(result.current));

    await waitFor(() => expect(api.listUserTags).toHaveBeenCalledTimes(2));
  });
});
