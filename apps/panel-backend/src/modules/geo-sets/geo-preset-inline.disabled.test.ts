import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { presetGeoInline } from './geo-preset-inline.js';

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('presetGeoInline with the switch off (the default)', () => {
  it('answers null, whatever the sets hold', async () => {
    expect(await presetGeoInline('ru-split')).toBeNull();
    expect(await presetGeoInline('cn-split')).toBeNull();
  });
});
