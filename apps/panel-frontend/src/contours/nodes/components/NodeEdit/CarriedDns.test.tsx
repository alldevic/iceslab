// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { CarriedDns } from '@/contours/nodes/components/NodeEdit/CarriedDns';
import { deferredReason } from '@/contours/nodes/lib/deferredDns';
import type { DeferredDnsEntry } from '@/lib/domain/nodes';

/*
 * 19.15: the node screen shows the DNS rules that did NOT reach the node (a
 * clash with another preset, the 16-server limit) under the carried ones, with
 * the reason and a link to the preset; with neither carried nor deferred there
 * is no block.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 5000 };
const PRESETS = {
  presets: [
    { id: 'pa', name: 'Alpha', builtIn: false, rules: [], dnsRules: [] },
    { id: 'pb', name: 'Beta', builtIn: false, rules: [], dnsRules: [] },
  ],
};
const CONFLICT: DeferredDnsEntry = { kind: 'conflict', presetId: 'pb', otherPresetId: 'pa', domain: 'example.com', server: '10.99.0.2' };
const LIMIT: DeferredDnsEntry = { kind: 'limit', presetId: 'pb', count: 19 };

function mount(props: React.ComponentProps<typeof CarriedDns>) {
  installEmptyApi({ routes: [{ re: /^\/api\/routing-presets$/, reply: PRESETS }] });
  return renderWithProviders(<CarriedDns {...props} />);
}

describe('CarriedDns, the deferred block', () => {
  it('names the clash: the other preset, the name and the preset it is left out of, linked', async () => {
    const view = mount({ carried: [], deferred: [CONFLICT] });
    const block = await screen.findByTestId('deferred-dns', {}, FIRST);
    await waitFor(() => expect(block.textContent).toContain('Beta'), FIRST);
    expect(block.textContent).toContain(view.i18n.t('nodeEdit.dnsDeferredTitle'));
    expect(block.textContent).toContain('Alpha');
    expect(block.textContent).toContain('example.com');
    expect(block.textContent).toContain('10.99.0.2');
    expect(block.querySelector('a[href="/subscription/routes?preset=pb"]')).not.toBeNull();
  });

  it('names the limit: the count and that the preset is left out whole', async () => {
    mount({ carried: [], deferred: [LIMIT] });
    const block = await screen.findByTestId('deferred-dns', {}, FIRST);
    expect(block.textContent).toContain('19');
    expect(block.textContent).toContain('16');
    expect(block.querySelector('a[href="/subscription/routes?preset=pb"]')).not.toBeNull();
  });

  it('a clash with the panel-wide rules says so instead of naming a preset', async () => {
    const view = mount({ carried: [], deferred: [{ ...CONFLICT, otherPresetId: null }] });
    const block = await screen.findByTestId('deferred-dns', {}, FIRST);
    expect(block.textContent).toContain(view.i18n.t('nodeEdit.dnsCarriedPanel'));
  });

  it('shows the carried rules and the deferred ones together, each under its own title', async () => {
    const view = mount({ carried: [{ presetId: 'pa', rules: [{ match: ['x.org'], server: '10.0.0.1', overridden: [] }] }], deferred: [CONFLICT] });
    expect(await screen.findByText(view.i18n.t('nodeEdit.dnsCarriedTitle'), {}, FIRST)).toBeTruthy();
    expect(await screen.findByText(view.i18n.t('nodeEdit.dnsDeferredTitle'), {}, FIRST)).toBeTruthy();
  });

  it('neither carried nor deferred: no block at all', () => {
    const view = mount({ carried: [], deferred: [] });
    expect(view.queryByTestId('carried-dns')).toBeNull();
    cleanup();
    expect(mount({ carried: undefined, deferred: undefined }).queryByTestId('carried-dns')).toBeNull();
  });

  it('only carried: no deferred block', async () => {
    mount({ carried: [{ presetId: null, rules: [{ match: ['x.org'], server: '10.0.0.1', overridden: [] }] }], deferred: [] });
    expect(await screen.findByTestId('carried-dns', {}, FIRST)).toBeTruthy();
    expect(screen.queryByTestId('deferred-dns')).toBeNull();
  });
});

describe('deferredReason', () => {
  const t = (key: string, vars?: Record<string, unknown>) => `${key} ${JSON.stringify(vars)}`;
  const nameOf = (id: string | null) => (id === null ? 'PANEL' : `name-${id}`);

  it('a clash gives the other source, the name and the server', () => {
    expect(deferredReason(CONFLICT, nameOf, t)).toBe('nodeEdit.dnsDeferredConflict {"other":"name-pa","domain":"example.com","server":"10.99.0.2"}');
    expect(deferredReason({ ...CONFLICT, otherPresetId: null }, nameOf, t)).toContain('"other":"PANEL"');
  });

  it('the limit gives the count', () => {
    expect(deferredReason(LIMIT, nameOf, t)).toBe('nodeEdit.dnsDeferredLimit {"count":19}');
  });
});
