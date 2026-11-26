// Закреплённое имя линии (11.3): имя сервера в клиенте подписчика не должно
// двигаться из-за правок, которые оператор делает для себя.
//
// Клиент, опознающий сервер по имени, на переименованную линию отвечает не
// переименованием, а ВТОРЫМ сервером рядом: старый продолжает брать трафик и
// упирается в отказ на входе, потому что тег в его UUID больше не совпадает с
// именем, которое панель знает. Поэтому здесь проверяются три вещи: закреплённое
// имя переживает переименование каскада, смену страны и ноды выхода; незакреплённая
// линия по-прежнему переименовывается, но сохранение говорит об этом
// (`lineRenames`); а пока поле пустое, имя ровно то, что было в базе.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { autoRouteTag } from './cascade.config.js';
import {
  createCascade,
  getCascade,
  getHysteriaEntryLabels,
  getRouteProfilesByEntryNode,
  updateCascade,
} from './cascade.service.js';
import { CreateCascadeSchema, UpdateCascadeSchema } from './cascade.schemas.js';
import * as loggerModule from '../../lib/infra/logger.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/infra/redis.js';

let entry: string;
let nl: string;
let se: string;
let de: string;

async function node(name: string, cc: string | null): Promise<string> {
  return (
    await prisma.node.create({
      data: {
        name,
        address: `${name}.example.com:1337`,
        protocol: 'xray',
        countryCode: cc,
        heartbeatSecret: randomBytes(32),
      },
      select: { id: true },
    })
  ).id;
}

const entryPos = (entryProtocol = 'xray') => [
  { position: 0, nodeIds: [entry], entryProtocol, linkProtocol: 'xray' },
];

async function make(opts: {
  name?: string;
  autoProfile?: boolean;
  autoLabel?: string | null;
  entryProtocol?: string;
  directions: { nodeIds?: string[]; countryCode?: string | null; label?: string | null; outboundId?: string }[];
}) {
  return createCascade({
    name: opts.name ?? 'ru',
    enabled: true,
    hideHopsFromSub: true,
    autoProfile: opts.autoProfile ?? false,
    autoLabel: opts.autoLabel,
    mode: 'chain',
    positions: entryPos(opts.entryProtocol),
    directions: opts.directions,
  });
}

const labelsOnEntry = async () =>
  ((await getRouteProfilesByEntryNode([entry])).get(entry) ?? []).map((p) => p.label);

let warn: ReturnType<typeof vi.fn>;
/** The rename warnings only: the service logs other things at warn level too. */
const renameWarnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('is now called'));

beforeEach(async () => {
  await cleanDatabase();
  entry = await node('ru-01', 'RU');
  nl = await node('nl-01', 'NL');
  se = await node('se-01', 'SE');
  de = await node('de-01', null);
  warn = vi.fn();
  vi.spyOn(loggerModule, 'getLogger').mockReturnValue({
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ReturnType<typeof loggerModule.getLogger>);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
  await closeRedis();
});

describe('a pinned direction name', () => {
  it('survives renaming the cascade, a country change and a change of the exit node', async () => {
    const c = await make({ directions: [{ nodeIds: [nl], countryCode: 'NL', label: 'Netherlands' }] });
    expect(await labelsOnEntry()).toEqual(['Netherlands']);

    const renamed = await updateCascade(c.id, { name: 'ru-moscow' });
    expect(await labelsOnEntry()).toEqual(['Netherlands']);
    expect(renamed.lineRenames).toEqual([]);

    const moved = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [{ id: c.directions[0]!.id, nodeIds: [nl], countryCode: 'SE' }],
    });
    expect(await labelsOnEntry()).toEqual(['Netherlands']);
    expect(moved.lineRenames).toEqual([]);

    const swapped = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [{ id: c.directions[0]!.id, nodeIds: [se], countryCode: null }],
    });
    expect(await labelsOnEntry()).toEqual(['Netherlands']);
    expect(swapped.lineRenames).toEqual([]);
    expect(swapped.directions[0]).toMatchObject({ label: 'Netherlands', lineLabel: 'Netherlands' });
    expect(renameWarnings()).toEqual([]);
  });

  it('is trimmed, and blank on create means not pinned', async () => {
    const c = await make({
      directions: [
        { nodeIds: [nl], countryCode: 'NL', label: '  Pinned  ' },
        { nodeIds: [se], countryCode: 'SE', label: '   ' },
      ],
    });
    expect(c.directions.map((d) => d.label)).toEqual(['Pinned', null]);
    expect(c.directions.map((d) => d.lineLabel)).toEqual(['Pinned', '🇸🇪 ru → SE']);
  });

  it('is refused above 64 characters in the schema, on create and on update', () => {
    const long = 'x'.repeat(65);
    const dir = { nodeIds: [nl], label: long };
    expect(CreateCascadeSchema.safeParse({ name: 'a', positions: entryPos(), directions: [dir] }).success).toBe(false);
    expect(UpdateCascadeSchema.safeParse({ positions: entryPos(), directions: [dir] }).success).toBe(false);
    expect(UpdateCascadeSchema.safeParse({ autoLabel: long }).success).toBe(false);
    expect(UpdateCascadeSchema.safeParse({ autoLabel: 'x'.repeat(64) }).success).toBe(true);
  });

  it('is left alone by a request that does not mention it, and cleared by null or an empty string', async () => {
    const c = await make({
      directions: [
        { nodeIds: [nl], countryCode: 'NL', label: 'Pinned NL' },
        { nodeIds: [se], countryCode: 'SE', label: 'Pinned SE' },
      ],
    });
    const [d1, d2] = c.directions;

    // No `label` key at all: both stay.
    const kept = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [
        { id: d1!.id, nodeIds: [nl] },
        { id: d2!.id, nodeIds: [se] },
      ],
    });
    expect(kept.directions.map((d) => d.label)).toEqual(['Pinned NL', 'Pinned SE']);
    expect(kept.lineRenames).toEqual([]);

    // null on one, '' on the other: both go back to the derived name, and the
    // save says what changed.
    const cleared = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [
        { id: d1!.id, nodeIds: [nl], label: null },
        { id: d2!.id, nodeIds: [se], label: '' },
      ],
    });
    expect(cleared.directions.map((d) => d.label)).toEqual([null, null]);
    expect(cleared.lineRenames).toEqual([
      { tag: 1, before: 'Pinned NL', after: '🇳🇱 ru → NL' },
      { tag: 2, before: 'Pinned SE', after: '🇸🇪 ru → SE' },
    ]);
    expect(await labelsOnEntry()).toEqual(['🇳🇱 ru → NL', '🇸🇪 ru → SE']);
  });

  it('is taken by a hysteria entry with a single direction, and the unpinned name is not', async () => {
    const c = await make({
      entryProtocol: 'hysteria',
      directions: [{ nodeIds: [nl], countryCode: 'NL', label: 'Netherlands' }],
    });
    expect((await getHysteriaEntryLabels([entry])).get(entry)).toBe('Netherlands');
    await updateCascade(c.id, { name: 'ru-2' });
    expect((await getHysteriaEntryLabels([entry])).get(entry)).toBe('Netherlands');
  });

  it('names a direction on a named outbound from the outbound, pinned or not', async () => {
    const outbound = await prisma.namedOutbound.create({
      data: { name: 'swiss-proxy', type: 'socks', config: { address: 'ch.example.com', port: 1080 }, countryCode: 'CH' },
    });
    const c = await make({ directions: [{ outboundId: outbound.id }] });
    expect(c.directions[0]!.lineLabel).toBe('🇨🇭 ru → CH');
    expect(await labelsOnEntry()).toEqual(['🇨🇭 ru → CH']);

    const pinned = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [{ id: c.directions[0]!.id, label: 'Swiss' }],
    });
    expect(pinned.lineRenames).toEqual([{ tag: 1, before: '🇨🇭 ru → CH', after: 'Swiss' }]);
    expect(await labelsOnEntry()).toEqual(['Swiss']);
  });
});

describe('an unpinned line is renamed with the cascade, and the save reports it', () => {
  it('lists the renamed line with its old and new name and writes a warning to the log', async () => {
    const c = await make({ directions: [{ nodeIds: [nl], countryCode: 'NL' }] });
    expect(await labelsOnEntry()).toEqual(['🇳🇱 ru → NL']);

    const saved = await updateCascade(c.id, { name: 'ru-moscow' });
    expect(saved.lineRenames).toEqual([{ tag: 1, before: '🇳🇱 ru → NL', after: '🇳🇱 ru-moscow → NL' }]);
    expect(await labelsOnEntry()).toEqual(['🇳🇱 ru-moscow → NL']);
    const warned = renameWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"🇳🇱 ru-moscow → NL"');
    expect(warned[0]).toContain('"🇳🇱 ru → NL"');
  });

  it('reports a country change as a rename of exactly that line', async () => {
    const c = await make({
      directions: [
        { nodeIds: [nl], countryCode: 'NL', label: 'Pinned' },
        { nodeIds: [se], countryCode: 'SE' },
      ],
    });
    const [d1, d2] = c.directions;
    const saved = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [
        { id: d1!.id, nodeIds: [nl], countryCode: 'DE' },
        { id: d2!.id, nodeIds: [se], countryCode: 'FI' },
      ],
    });
    expect(saved.lineRenames).toEqual([{ tag: 2, before: '🇸🇪 ru → SE', after: '🇫🇮 ru → FI' }]);
  });

  it('answers an empty list for a save that renames nothing', async () => {
    const c = await make({ directions: [{ nodeIds: [nl], countryCode: 'NL' }] });
    const saved = await updateCascade(c.id, { hideHopsFromSub: false });
    expect(saved.lineRenames).toEqual([]);
    expect(renameWarnings()).toEqual([]);
  });

  it('does not count a new or a removed line as a rename', async () => {
    const c = await make({ directions: [{ nodeIds: [nl], countryCode: 'NL' }] });
    const added = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [{ id: c.directions[0]!.id, nodeIds: [nl] }, { nodeIds: [se], countryCode: 'SE' }],
    });
    expect(added.lineRenames).toEqual([]);
    const removed = await updateCascade(c.id, {
      positions: entryPos(),
      directions: [{ id: c.directions[0]!.id, nodeIds: [nl] }],
    });
    expect(removed.lineRenames).toEqual([]);
  });

  it('falls back to the exit node name for a direction with no country', async () => {
    const c = await make({ directions: [{ nodeIds: [de] }] });
    expect(c.directions[0]!.lineLabel).toBe('ru → de-01');
    expect(await labelsOnEntry()).toEqual(['ru → de-01']);
  });
});

describe('the Auto line', () => {
  // A function: the node ids exist only after beforeEach has run.
  const exits = () => [
    { nodeIds: [nl], countryCode: 'NL' },
    { nodeIds: [se], countryCode: 'SE' },
  ];

  it('keeps a pinned name across renaming the cascade, with the policy suffix on top', async () => {
    const policy = await prisma.routePolicy.create({ data: { name: 'no-ads', ordinal: 1 } });
    const group = await prisma.group.create({ data: { name: 'g' } });
    await prisma.groupRoutePolicy.create({ data: { groupId: group.id, policyId: policy.id } });
    const c = await make({ autoProfile: true, autoLabel: 'Fastest', directions: exits() });

    const before = ((await getRouteProfilesByEntryNode([entry], [group.id])).get(entry) ?? []).map((p) => p.label);
    expect(before.slice(0, 2)).toEqual(['Fastest', 'Fastest · no-ads']);

    const saved = await updateCascade(c.id, { name: 'ru-moscow' });
    const after = ((await getRouteProfilesByEntryNode([entry], [group.id])).get(entry) ?? []).map((p) => p.label);
    expect(after.slice(0, 2)).toEqual(['Fastest', 'Fastest · no-ads']);
    // The two direction lines are unpinned and moved; Auto did not.
    expect(saved.lineRenames.map((r) => r.tag)).toEqual([1, 2]);
    expect(saved.autoLineLabel).toBe('Fastest');
  });

  it('is reported under the Auto tag when unpinned, and only while autoProfile is on', async () => {
    const c = await make({ autoProfile: true, directions: exits() });
    const saved = await updateCascade(c.id, { name: 'ru-moscow' });
    expect(saved.lineRenames).toContainEqual({
      tag: autoRouteTag(0),
      before: '⚡ ru → Auto',
      after: '⚡ ru-moscow → Auto',
    });

  });

  it('stays out of lineRenames while autoProfile is off', async () => {
    const c = await make({ autoProfile: false, directions: exits() });
    const saved = await updateCascade(c.id, { name: 'ru-moscow' });
    expect(saved.lineRenames.map((r) => r.tag)).toEqual([1, 2]);
    expect(saved.lineRenames.some((r) => r.tag === autoRouteTag(0))).toBe(false);
  });

  it('is pinned, left alone and cleared with the same three values', async () => {
    const c = await make({ directions: exits() });
    expect(c.autoLabel).toBeNull();

    const pinned = await updateCascade(c.id, { autoLabel: '  Fastest  ' });
    expect(pinned.autoLabel).toBe('Fastest');
    expect(pinned.autoLineLabel).toBe('Fastest');

    const untouched = await updateCascade(c.id, { name: 'ru-2' });
    expect(untouched.autoLabel).toBe('Fastest');

    const cleared = await updateCascade(c.id, { autoLabel: '' });
    expect(cleared.autoLabel).toBeNull();
    expect(cleared.autoLineLabel).toBe('⚡ ru-2 → Auto');
    const viaNull = await updateCascade(c.id, { autoLabel: 'Again' });
    expect(viaNull.autoLabel).toBe('Again');
    expect((await updateCascade(c.id, { autoLabel: null })).autoLabel).toBeNull();
  });

  it('names a hysteria entry with several directions by the pinned Auto name', async () => {
    await make({ entryProtocol: 'hysteria', autoLabel: 'Fastest', directions: exits() });
    expect((await getHysteriaEntryLabels([entry])).get(entry)).toBe('Fastest');
  });
});

describe('with nothing pinned the names are those of the base', () => {
  it('reads null for both columns on every existing row and derives as before', async () => {
    const c = await make({ autoProfile: true, directions: [{ nodeIds: [nl], countryCode: 'NL' }, { nodeIds: [se] }] });
    const row = await prisma.cascade.findUniqueOrThrow({ where: { id: c.id }, include: { directions: true } });
    expect(row.autoLabel).toBeNull();
    expect(row.directions.map((d) => d.label)).toEqual([null, null]);
    expect(await labelsOnEntry()).toEqual(['⚡ ru → Auto', '🇳🇱 ru → NL', '🇸🇪 ru → SE']);
    expect((await getCascade(c.id)).directions.map((d) => d.lineLabel)).toEqual(['🇳🇱 ru → NL', '🇸🇪 ru → SE']);
  });
});
