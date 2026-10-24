import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_SERVER_DESCRIPTION_MAX,
  serverDescriptionProblem,
  showsServerDescription,
  isHappUserAgent,
} from '@iceslab/shared';

/**
 * A-236 step 6: the shared rule for a host's description, the one the server's
 * schema and the host form both call.
 */

describe('serverDescriptionProblem', () => {
  it('counts code points: an emoji is one', () => {
    const flags = '🇩🇪'.repeat(HOST_SERVER_DESCRIPTION_MAX / 2); // two code points each
    expect(serverDescriptionProblem(flags)).toBeNull();
    expect(serverDescriptionProblem('😀'.repeat(HOST_SERVER_DESCRIPTION_MAX))).toBeNull();
    expect(serverDescriptionProblem('😀'.repeat(HOST_SERVER_DESCRIPTION_MAX + 1))).toBe('too-long');
    expect(serverDescriptionProblem('a'.repeat(HOST_SERVER_DESCRIPTION_MAX + 1))).toBe('too-long');
  });

  it('one line: \\r, \\n, U+2028, U+2029 and control characters are refused', () => {
    for (const ch of ['\n', '\r', '\u2028', '\u2029', '\u0000', '\u0007', '\u007f', '\t']) {
      expect(serverDescriptionProblem(`Fast${ch}lane`), JSON.stringify(ch)).toBe('multiline');
    }
  });

  it('spaces only is empty; spaces around real text stay', () => {
    expect(serverDescriptionProblem('')).toBe('empty');
    expect(serverDescriptionProblem('   ')).toBe('empty');
    expect(serverDescriptionProblem('  Fast lane  ')).toBeNull();
    expect(serverDescriptionProblem('Frankfurt: "fast", 10 Gbit')).toBeNull();
  });

  it('the source holds no literal line separator: a bundler reads U+2028 in a regex literal as a line end', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/shared/src/hosts.ts'), 'utf8');
    expect(/[\u2028\u2029]/.test(src)).toBe(false);
  });
});

describe('the apps that show a description', () => {
  it('by the start of the User-Agent; Happ also by link', () => {
    expect(showsServerDescription('Happ/3.2.1')).toBe(true);
    expect(showsServerDescription('FlClash X/0.3')).toBe(true);
    expect(showsServerDescription('INCY/1.0')).toBe(true);
    expect(showsServerDescription('clash-verge/v2.0.0')).toBe(false);
    expect(showsServerDescription(null)).toBe(false);
    expect(isHappUserAgent('Happ/3.2.1')).toBe(true);
    expect(isHappUserAgent('INCY/1.0')).toBe(false);
  });
});
