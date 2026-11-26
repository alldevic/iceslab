// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { CreateNodePolicySchema, UpdateNodePolicySchema } from '@backend/modules/node-policies/node-policies.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { accepted, theWrite } from '@/test/formDrive';
import { NodePolicyEditor } from '@/contours/traffic/components/NodePolicy/NodePolicyEditor';
import { blankNodePolicy, type NodePolicy } from '@/lib/domain/nodePolicies';

/*
 * The node-policy editor (a feature of the migration with a schema of its own)
 * against CreateNodePolicySchema / UpdateNodePolicySchema (milestone 17.5): the
 * editor is mounted on a blank draft and on a stored policy and saved.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 5000 };
const ID = '11111111-1111-4111-8111-111111111111';
const DIR = '22222222-2222-4222-8222-222222222222';
const R = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

const rule = (n: number, over: Partial<NodePolicy['rules'][number]>): NodePolicy['rules'][number] => ({
  id: R(n),
  position: n,
  enabled: true,
  match: { domain: [], ip: [], port: null, protocol: [], network: null },
  action: { kind: 'direct', directionId: null },
  ...over,
});

const STORED: NodePolicy = {
  id: ID,
  name: 'ru-direct',
  description: null,
  rules: [
    rule(1, { match: { domain: ['geosite:category-ru', 'example.ru'], ip: [], port: null, protocol: [], network: null } }),
    rule(2, { match: { domain: [], ip: ['geoip:ru', '10.0.0.0/8'], port: '80,443', protocol: ['tls'], network: 'tcp' }, action: { kind: 'block', directionId: null } }),
    rule(3, { enabled: false, action: { kind: 'warp', directionId: null }, match: { domain: ['domain:example.com'], ip: [], port: null, protocol: [], network: 'tcp,udp' } }),
    rule(4, { action: { kind: 'cascade', directionId: DIR }, match: { domain: ['geosite:google'], ip: [], port: '1000-2000', protocol: [], network: null } }),
  ],
  nodeCount: 0,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

function mount(policy: NodePolicy, isDraft: boolean) {
  const api = installEmptyApi({
    onWrite: (r) => (r.method === 'POST' || r.method === 'PUT' ? { data: STORED } : undefined),
  });
  const view = renderWithProviders(
    <NodePolicyEditor policy={policy} directions={[]} isDraft={isDraft} onSaved={() => {}} onDeleted={() => {}} />,
  );
  return { api, view };
}

describe('node policy editor', () => {
  it('a blank draft with a name only: the request passes CreateNodePolicySchema', async () => {
    const { api, view } = mount(blankNodePolicy(), true);
    fireEvent.change(await screen.findByPlaceholderText(view.i18n.t('routes.nodePolicyNamePlaceholder'), {}, FIRST), { target: { value: 'fresh' } });
    const create = (await screen.findByRole('button', { name: view.i18n.t('routes.nodeCreate') })) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false), FIRST);
    fireEvent.click(create);
    await waitFor(() => theWrite(api.calls, 'POST', '/api/node-policies'), FIRST);
    const parsed = accepted(CreateNodePolicySchema, theWrite(api.calls, 'POST', '/api/node-policies').body);
    expect(parsed).toMatchObject({ name: 'fresh', rules: [] });
  });

  it('a stored policy of four rules, renamed: the list goes back whole, ids kept, and passes UpdateNodePolicySchema', async () => {
    const { api, view } = mount(STORED, false);
    const name = (await screen.findByDisplayValue('ru-direct', {}, FIRST)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'ru-direct-2' } });
    const save = (await screen.findByRole('button', { name: view.i18n.t('common.save') })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), FIRST);
    fireEvent.click(save);
    await waitFor(() => theWrite(api.calls, 'PUT', `/api/node-policies/${ID}`), FIRST);
    const body = theWrite(api.calls, 'PUT', `/api/node-policies/${ID}`).body as { name: string; rules: Array<Record<string, unknown>> };
    accepted(UpdateNodePolicySchema, body);
    expect(body.name).toBe('ru-direct-2');
    expect(body.rules).toEqual(
      STORED.rules.map((r) => ({
        id: r.id,
        enabled: r.enabled,
        match: r.match,
        action: r.action.kind === 'cascade' ? { kind: 'cascade', directionId: DIR } : { kind: r.action.kind },
      })),
    );
  });
});
