import { describe, expect, it } from 'vitest';
import { isUniqueViolationOn, uniqueViolationOf } from './unique-violation.js';

// The shape measured 24.10 on cascades.name through @prisma/adapter-pg 7.10.
const ADAPTER = {
  code: 'P2002',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        kind: 'UniqueConstraintViolation',
        constraint: { index: 'cascades_name_key' },
        table: 'cascades',
      },
    },
    modelName: 'Cascade',
  },
};

describe('uniqueViolationOf (A-127)', () => {
  it('reads the index the pg adapter names, where meta.target is absent', () => {
    expect(uniqueViolationOf(ADAPTER)).toEqual({ index: 'cascades_name_key', fields: [] });
    expect(isUniqueViolationOn(ADAPTER, 'cascades_name_key', ['name'])).toBe(true);
    expect(isUniqueViolationOn(ADAPTER, 'cascade_tunnels_index_key', ['index'])).toBe(false);
  });

  it('reads fields, from the adapter or from meta.target', () => {
    const fields = { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['name'] } } } } };
    expect(isUniqueViolationOn(fields, 'cascades_name_key', ['name'])).toBe(true);
    expect(isUniqueViolationOn({ code: 'P2002', meta: { target: ['index'] } }, 'cascades_name_key', ['name'])).toBe(false);
    expect(isUniqueViolationOn({ code: 'P2002', meta: { target: 'cascades_name_key' } }, 'cascades_name_key', ['name'])).toBe(true);
  });

  it('is nothing for another error, and no guess for a P2002 that names nothing', () => {
    expect(uniqueViolationOf(new Error('x'))).toBeNull();
    expect(uniqueViolationOf({ code: 'P2003' })).toBeNull();
    expect(isUniqueViolationOn({ code: 'P2002' }, 'cascades_name_key', ['name'])).toBe(false);
  });
});
