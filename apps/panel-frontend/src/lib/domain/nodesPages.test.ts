import { describe, expect, it } from 'vitest';
import { collectNodePages, NODES_PAGE_MAX, type Node, type NodesListResponse } from '@/lib/domain/nodes';

const node = (i: number) => ({ id: `n${i}`, name: `node-${i}` }) as unknown as Node;
const fleet = (n: number) => Array.from({ length: n }, (_, i) => node(i + 1));

/** A server that pages `all` honestly, recording which pages were asked. */
function server(all: Node[], asked: number[], fields?: string[]) {
  return async (page: number): Promise<NodesListResponse> => {
    asked.push(page);
    const nodes = all.slice((page - 1) * NODES_PAGE_MAX, page * NODES_PAGE_MAX);
    return { nodes, total: all.length, page, limit: NODES_PAGE_MAX, ...(fields ? { fields } : {}) };
  };
}

describe('collectNodePages (A-138)', () => {
  it('три страницы: все 250 нод, ровно три запроса, fields первой страницы', async () => {
    const asked: number[] = [];
    const res = await collectNodePages(server(fleet(250), asked, ['cores']));
    expect(res.nodes).toHaveLength(250);
    expect(res.nodes.at(-1)?.id).toBe('n250');
    expect(res.total).toBe(250);
    expect(res.fields).toEqual(['cores']);
    expect(asked).toEqual([1, 2, 3]);
  });

  it('ровно страница: второй раз не спрашивает', async () => {
    const asked: number[] = [];
    expect((await collectNodePages(server(fleet(100), asked))).nodes).toHaveLength(100);
    expect(asked).toEqual([1]);
  });

  it('пустой парк: один запрос, пустой список', async () => {
    const asked: number[] = [];
    expect((await collectNodePages(server([], asked))).nodes).toEqual([]);
    expect(asked).toEqual([1]);
  });

  it('список сдвинулся под обходом: нода на стыке страниц не удваивается', async () => {
    const all = fleet(150);
    const res = await collectNodePages(async (page) => {
      // A node was added at the top between the two requests: page 2 starts one earlier.
      const from = page === 1 ? 0 : NODES_PAGE_MAX - 1;
      return { nodes: all.slice(from, from + NODES_PAGE_MAX), total: 150, page, limit: NODES_PAGE_MAX };
    });
    expect(res.nodes).toHaveLength(150);
    expect(new Set(res.nodes.map((n) => n.id)).size).toBe(150);
  });

  it('сервер, не знающий page, не крутит обход вечно', async () => {
    const asked: number[] = [];
    const page1 = fleet(100);
    const res = await collectNodePages(async (page) => {
      asked.push(page);
      return { nodes: page1, total: 300, page: 1, limit: NODES_PAGE_MAX };
    });
    expect(res.nodes).toHaveLength(100);
    expect(asked).toEqual([1, 2]);
  });
});
