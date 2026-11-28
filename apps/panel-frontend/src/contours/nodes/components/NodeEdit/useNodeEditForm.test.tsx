// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Node } from '@/lib/domain/nodes';
import * as nodesApi from '@/lib/domain/nodes';
import { nodes as ruNodes } from '@/i18n/locales/ru/nodes';
import { useNodeEditForm } from '@/contours/nodes/components/NodeEdit/useNodeEditForm';

/*
 * Форма ноды: заполнение при смене id в маршруте без перемонтирования (f14-11)
 * и перечитывание ноды после WARP (f14-12). Всё, что хук читает кроме самой
 * ноды, отвечает пустым списком.
 */

vi.mock('@/lib/domain/nodes', async (orig) => ({
  ...(await orig<typeof import('@/lib/domain/nodes')>()),
  findNode: vi.fn(),
  listRegions: vi.fn(async () => []),
  listAllNodes: vi.fn(async () => []),
  getNodeSyncStatus: vi.fn(async () => null),
  getNodeExposure: vi.fn(async () => null),
  registerNodeWarp: vi.fn(async () => ({})),
  disableNodeWarp: vi.fn(async () => ({})),
  updateNode: vi.fn(),
}));
// The keys come back as they are, except the save warning: that one reads the real ru table.
vi.mock('react-i18next', async () => {
  const { nodes } = await import('@/i18n/locales/ru/nodes');
  return {
    useTranslation: () => ({
      t: (k: string) => (k === 'nodeEdit.warnings.CERT_NOT_PREPARED' ? nodes.nodeEdit.warnings.CERT_NOT_PREPARED : k),
      i18n: { language: 'ru' },
    }),
  };
});
vi.mock('@/lib/domain/profiles', () => ({ listBindings: vi.fn(async () => []), listProfiles: vi.fn(async () => []) }));
vi.mock('@/lib/domain/cascades', () => ({ listCascades: vi.fn(async () => []) }));
vi.mock('@/lib/domain/hosts', () => ({ listHosts: vi.fn(async () => []) }));
vi.mock('@/lib/domain/routePolicies', () => ({ listRoutePolicies: vi.fn(async () => []) }));
vi.mock('@/lib/domain/nodePolicies', () => ({
  listNodePolicies: vi.fn(async () => []),
  policyFitRefusal: vi.fn(() => null),
}));
vi.mock('@/lib/domain/squads', () => ({ listSquads: vi.fn(async () => []) }));
vi.mock('@/lib/domain/dashboard', () => ({
  useOverview: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));

const node = (id: string, over: Partial<Node> = {}): Node =>
  ({
    id,
    name: `node-${id}`,
    address: `${id}.test:8443`,
    protocol: 'xray',
    status: 'online',
    consumptionMultiplier: 1,
    warpEnabled: false,
    ...over,
  }) as unknown as Node;

const findNode = vi.mocked(nodesApi.findNode);

// useParams needs a route context: render the hook inside the route element.
function renderInRoute(startId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const holder: { current: ReturnType<typeof useNodeEditForm> | null } = { current: null };
  function Probe() {
    holder.current = useNodeEditForm();
    return null;
  }
  const router = createMemoryRouter([{ path: '/nodes/:id', element: <Probe /> }], {
    initialEntries: [`/nodes/${startId}`],
  });
  const view = renderHook(() => null, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
        {children}
      </QueryClientProvider>
    ),
  });
  return { result: holder, router, client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  findNode.mockImplementation(async (id: string) => node(id, { name: `node-${id}` }));
});

describe('useNodeEditForm: заполнение формы', () => {
  it('форма заполнена из своей ноды', async () => {
    const { result } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    expect(result.current?.form.values.inService).toBe(true);
  });

  it('смена id в маршруте без перемонтирования: значения второй ноды', async () => {
    findNode.mockImplementation(async (id: string) => node(id, { status: id === 'b' ? 'disabled' : 'online' }));
    const { result, router } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    await act(() => router.navigate('/nodes/b'));
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-b'));
    expect(result.current?.form.values.inService).toBe(false);
  });

  it('правки оператора не затираются при повторном чтении той же ноды', async () => {
    const { result, client } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    act(() => result.current?.form.setFieldValue('name', 'edited-by-me'));
    findNode.mockImplementation(async (id: string) => node(id, { name: 'renamed-elsewhere' }));
    await act(() => client.invalidateQueries({ queryKey: ['node', 'a'] }));
    await waitFor(() => expect(findNode).toHaveBeenCalledTimes(2));
    expect(result.current?.form.values.name).toBe('edited-by-me');
  });

  it('переключатель «В работе» сохранённой отключённой ноды открыт выключенным', async () => {
    findNode.mockImplementation(async (id: string) => node(id, { status: 'disabled' }));
    const { result } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    expect(result.current?.form.values.inService).toBe(false);
  });
});

describe('useNodeEditForm: WARP', () => {
  it('после успеха мутации нода перечитана: запрос node, id', async () => {
    const { result } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    expect(findNode).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current?.warpMutation.mutate(true);
    });
    await waitFor(() => expect(findNode).toHaveBeenCalledTimes(2));
  });
});

describe('useNodeEditForm: save warnings (19.15)', () => {
  const update = vi.mocked(nodesApi.updateNode);

  it('a known code shows its Russian text, not the server English', async () => {
    const show = vi.spyOn(notifications, 'show').mockReturnValue('x');
    update.mockResolvedValue({
      ...node('a', {}),
      warnings: [{ code: 'CERT_NOT_PREPARED', message: 'Thell node certificate may not contain the new address' }],
    });
    const { result } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    await act(async () => {
      result.current?.saveMutation.mutate();
    });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.calls[1][0]).toMatchObject({
      color: 'yellow',
      title: 'nodeEdit.savedWithWarnings',
      message: ruNodes.nodeEdit.warnings.CERT_NOT_PREPARED,
    });
  });

  it('an unknown code shows the server message', async () => {
    const show = vi.spyOn(notifications, 'show').mockReturnValue('x');
    update.mockResolvedValue({
      ...node('a', {}),
      warnings: [{ code: 'SOMETHING_NEW', message: 'node unreachable, certificate not reissued' }],
    });
    const { result } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    await act(async () => {
      result.current?.saveMutation.mutate();
    });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.calls[1][0]).toMatchObject({ message: 'node unreachable, certificate not reissued' });
  });

  it('a save without warnings shows only the saved toast', async () => {
    const show = vi.spyOn(notifications, 'show').mockReturnValue('x');
    update.mockResolvedValue(node('a', {}));
    const { result } = renderInRoute('a');
    await waitFor(() => expect(result.current?.form.values.name).toBe('node-a'));
    await act(async () => {
      result.current?.saveMutation.mutate();
    });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.calls[0][0]).toMatchObject({ color: 'green' });
  });
});
