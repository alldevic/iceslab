// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { CreateCascadeSchema, UpdateCascadeSchema } from '@backend/modules/cascades/cascade.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { accepted, theWrite } from '@/test/formDrive';
import { nodeRecord } from '@/test/records';
import { CascadeCreatePage } from '@/contours/cascades/screens/CascadeCreatePage';
import { CascadeEditPage } from '@/contours/cascades/screens/CascadeEditPage';
import { toDirectionInputs, toPositionInputs, type DirectionDraft, type PositionDraft } from '@/contours/cascades/lib/cascadeForm';
import type { Cascade } from '@/lib/domain/cascades';

/*
 * The cascade forms against CreateCascadeSchema / UpdateCascadeSchema
 * (milestone 17.5).
 *
 * Create: the drafts the create page starts from, with the two required
 * choices made (an entry node, an exit country with its node), go through the
 * same two pure functions the page's request is built from.
 *
 * Edit: the edit page is mounted on a stored cascade and saved after a rename;
 * the topology goes back whole, with each direction's id, which is what keeps
 * its tag.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const U = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const T0 = '2026-08-01T00:00:00.000Z';
const NODES = [U(1), U(2), U(3), U(4), U(7)].map((id, i) =>
  nodeRecord({ id, name: `n${i + 1}`, address: `10.0.0.${i + 1}:8443`, countryCode: i < 3 ? 'DE' : 'NL', coreVersion: '99.0.0', engines: ['xray', 'singbox'] }),
);

describe('cascade create page, the required choices only', () => {
  it('a name, an entry node, an exit country and its node: the request passes CreateCascadeSchema', { timeout: 20000 }, async () => {
    const api = installEmptyApi({
      routes: [{ re: /^\/api\/nodes$/, reply: { nodes: NODES, total: NODES.length, page: 1, limit: 100, fields: [] } }],
      onWrite: (r) => (r.method === 'POST' && r.url === '/api/cascades' ? { data: { ...STORED_FOR_CREATE } } : undefined),
    });
    const view = renderWithProviders(
      <Routes>
        <Route path="/nodes/cascades/new" element={<CascadeCreatePage />} />
        <Route path="/nodes" element={<div>nodes</div>} />
      </Routes>,
      { route: '/nodes/cascades/new' },
    );
    const FIRST = { timeout: 5000 };
    // Mantine keeps a closed list in the DOM without an accessible name: the options of a picker are found
    // through the `aria-controls` of its input, by their text.
    const choose = async (box: HTMLElement, re: RegExp) => {
      fireEvent.click(box);
      const option = await waitFor(() => {
        const list = document.getElementById(box.getAttribute('aria-controls') ?? '');
        const hit = [...(list?.querySelectorAll<HTMLElement>('[role=option]') ?? [])].find((o) => re.test(o.textContent ?? ''));
        expect(hit, `${re} in the list of ${box.getAttribute('placeholder')}`).toBeTruthy();
        return hit!;
      }, FIRST);
      fireEvent.click(option);
    };
    const pickNode = async (index: number, name: string) =>
      choose((await screen.findAllByPlaceholderText(view.i18n.t('cascadeCreate.nodePlaceholder'), {}, FIRST))[index]!, new RegExp(`${name}\\d`));
    fireEvent.change(await screen.findByPlaceholderText('ru-eu-1', {}, FIRST), { target: { value: 'DE-NL' } });
    await pickNode(0, 'n1');
    await choose(await screen.findByPlaceholderText(view.i18n.t('cascadeCreate.countryPlaceholder'), {}, FIRST), /Netherlands/);
    await pickNode(1, 'n4');
    const create = (await screen.findByRole('button', { name: view.i18n.t('cascadeCreate.create') })) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false), FIRST);
    fireEvent.click(create);
    await waitFor(() => theWrite(api.calls, 'POST', '/api/cascades'), FIRST);
    const body = theWrite(api.calls, 'POST', '/api/cascades').body as Record<string, unknown>;
    const parsed = accepted(CreateCascadeSchema, body);
    expect(parsed).toMatchObject({ name: 'DE-NL', enabled: true, hideHopsFromSub: true });
    expect(body.positions).toEqual([{ nodeIds: [NODES[0]!.id], position: 0, entryProtocol: 'xray', linkProtocol: 'xray' }]);
    expect(body.directions).toEqual([{ countryCode: 'NL', nodeIds: [NODES[3]!.id] }]);
  });

  // The create path reads two pure functions; the drafts below are the shapes the page builds with more positions.
  const pools: PositionDraft[] = [{ key: 0, nodeIds: [NODES[0]!.id], entryProtocol: 'xray', linkProtocol: 'xray' }];
  const directions: DirectionDraft[] = [{ key: 1, id: null, countryCode: 'NL', nodeIds: [NODES[3]!.id], tag: null }];

  it('an empty slot left in the pools is dropped from the request, not sent as an empty id', () => {
    const body = {
      name: 'x',
      positions: toPositionInputs([{ ...pools[0]!, nodeIds: [NODES[0]!.id, ''] }]),
      directions: toDirectionInputs([{ ...directions[0]!, nodeIds: [NODES[3]!.id, ''] }]),
    };
    accepted(CreateCascadeSchema, body);
  });

  it('a transit position and a direction with a pinned name pass too', () => {
    const body = {
      name: 'three-hop',
      positions: toPositionInputs([
        pools[0]!,
        { key: 5, nodeIds: [NODES[1]!.id], entryProtocol: 'xray', linkProtocol: 'xray' },
      ]),
      directions: toDirectionInputs([{ ...directions[0]!, label: ' Netherlands ' }]),
    };
    const parsed = accepted(CreateCascadeSchema, body);
    expect(parsed.directions?.[0]?.label).toBe('Netherlands');
  });
});

const STORED_FOR_CREATE = { id: U(8), name: 'DE-NL', enabled: true, mode: 'chain', hideHopsFromSub: true, autoProfile: false, hops: [], positions: [], directions: [], nextDirectionTag: 1, createdAt: T0, updatedAt: T0 };

describe('cascade edit, opened on a stored cascade', () => {
  const CASCADE_ID = U(9);
  const DIR_A = U(5);
  const DIR_B = U(6);
  const STORED: Cascade = {
    id: CASCADE_ID,
    name: 'DE-NL',
    enabled: true,
    mode: 'chain',
    hideHopsFromSub: false,
    autoProfile: true,
    autoLabel: 'Fastest',
    hops: [],
    positions: [
      { position: 0, nodeIds: [NODES[0]!.id, NODES[1]!.id], entryProtocol: 'xray', linkProtocol: 'xray', linkParams: null },
      { position: 1, nodeIds: [NODES[2]!.id], entryProtocol: null, linkProtocol: 'xray', linkParams: null },
    ],
    directions: [
      { id: DIR_A, tag: 1, countryCode: 'NL', label: 'Netherlands', nodeIds: [NODES[3]!.id], outboundId: null, linkProtocol: null, linkParams: null, linkPort: 24001 },
      { id: DIR_B, tag: 3, countryCode: 'NL', label: null, nodeIds: [NODES[4]!.id], outboundId: null, linkProtocol: null, linkParams: null, linkPort: 24001 },
    ],
    nextDirectionTag: 4,
    entryPolicy: null,
    createdAt: T0,
    updatedAt: T0,
  };

  it('saved after a rename, the whole topology goes back and passes UpdateCascadeSchema', { timeout: 15000 }, async () => {
    const api = installEmptyApi({
      routes: [
        { re: /^\/api\/cascades$/, reply: { cascades: [STORED], fields: ['entryPolicy', 'directions[].outboundId'] } },
        { re: /^\/api\/nodes$/, reply: { nodes: NODES, total: NODES.length, page: 1, limit: 100, fields: [] } },
      ],
      onWrite: (r) => (r.method === 'PUT' ? { data: STORED } : undefined),
    });
    const view = renderWithProviders(
      <Routes>
        <Route path="/nodes/cascades/:id" element={<CascadeEditPage />} />
      </Routes>,
      { route: `/nodes/cascades/${CASCADE_ID}` },
    );
    const name = (await screen.findByDisplayValue('DE-NL', {}, { timeout: 5000 })) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'DE-NL 2' } });
    const save = (await screen.findByRole('button', { name: view.i18n.t('cascadeEdit.save') })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(save);
    await waitFor(() => theWrite(api.calls, 'PUT', `/api/cascades/${CASCADE_ID}`));
    const body = theWrite(api.calls, 'PUT', `/api/cascades/${CASCADE_ID}`).body as Record<string, unknown>;
    accepted(UpdateCascadeSchema, body);
    expect(body).toMatchObject({ name: 'DE-NL 2', enabled: true, hideHopsFromSub: false, autoProfile: true, autoLabel: 'Fastest' });
    expect(body.positions).toEqual([
      { nodeIds: [NODES[0]!.id, NODES[1]!.id], position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
      { nodeIds: [NODES[2]!.id], position: 1, linkProtocol: 'xray' },
    ]);
    // The id of each direction is what keeps its tag; the tag itself is never sent.
    expect(body.directions).toEqual([
      { id: DIR_A, countryCode: 'NL', label: 'Netherlands', nodeIds: [NODES[3]!.id] },
      { id: DIR_B, countryCode: 'NL', label: '', nodeIds: [NODES[4]!.id] },
    ]);
    // An entry policy that was not touched is not part of the request.
    expect(body).not.toHaveProperty('entryPolicyId');
  });
});
