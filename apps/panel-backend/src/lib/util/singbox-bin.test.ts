import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBinary, singboxAvailable, singboxBinary } from './singbox-bin.js';

afterEach(() => vi.unstubAllEnvs());

describe('where the panel finds sing-box', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'iceslab-sbbin-')), 'sing-box');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);

  it('SINGBOX_BIN wins, as given', () => {
    vi.stubEnv('SINGBOX_BIN', '/nowhere/sing-box');
    expect(singboxBinary()).toBe('/nowhere/sing-box');
    expect(singboxAvailable()).toBe(false);
    vi.stubEnv('SINGBOX_BIN', file);
    expect(singboxAvailable()).toBe(true);
  });

  it('blank counts as unset: the install paths are tried, and none is no binary', () => {
    vi.stubEnv('SINGBOX_BIN', '  ');
    expect(singboxBinary()).toBe(findBinary(undefined, ['/usr/local/bin/sing-box', '/usr/bin/sing-box']));
  });

  it('findBinary: the env path, else the first existing path, else nothing', () => {
    expect(findBinary('/x/y', [file])).toBe('/x/y');
    expect(findBinary(undefined, ['/nowhere/a', file])).toBe(file);
    expect(findBinary(undefined, ['/nowhere/a'])).toBe('');
    expect(singboxAvailable('')).toBe(false);
  });
});
