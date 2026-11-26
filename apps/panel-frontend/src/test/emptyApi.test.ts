// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/net/client';
import { installEmptyApi, NOT_FOUND } from '@/test/emptyApi';
import { listNodes } from '@/lib/domain/nodes';

/*
 * The empty-panel fixture is what the screen tests stand on, so its own rules
 * are pinned here: a path nobody described fails by name, a missing record is
 * a 404, and writes are logged and refused unless a test answers them.
 */

afterEach(() => vi.restoreAllMocks());

describe('emptyApi', () => {
  it('answers a described read with its typed empty body and logs it', async () => {
    const stub = installEmptyApi();
    await expect(listNodes({ page: 1 })).resolves.toMatchObject({ nodes: [], total: 0 });
    expect(stub.gets(/^\/api\/nodes$/)).toHaveLength(1);
    expect(stub.unknown).toEqual([]);
  });

  it('an undescribed address fails with the address in the message and in `unknown`', async () => {
    const stub = installEmptyApi();
    await expect(api.get('/api/not-in-the-fixture')).rejects.toThrow('GET /api/not-in-the-fixture');
    expect(() => stub.assertNoUnknown()).toThrow('/api/not-in-the-fixture');
  });

  it('a record that is not there is a 404 like the backend words it', async () => {
    installEmptyApi();
    await expect(api.get('/api/nodes/abc')).rejects.toMatchObject({ response: { status: 404 } });
    expect(NOT_FOUND).toBeTypeOf('symbol');
  });

  it('a write is logged with its body, and refused unless onWrite answers it', async () => {
    const stub = installEmptyApi({ onWrite: (r) => (r.url === '/api/ok' ? { data: { fine: true } } : undefined) });
    await expect(api.post('/api/ok', { a: 1 })).resolves.toMatchObject({ data: { fine: true } });
    await expect(api.put('/api/nope', { b: 2 })).rejects.toThrow('PUT /api/nope');
    expect(stub.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/ok', { a: 1 }],
      ['PUT', '/api/nope', { b: 2 }],
    ]);
    expect(stub.unknown).toEqual(['PUT /api/nope']);
  });
});
