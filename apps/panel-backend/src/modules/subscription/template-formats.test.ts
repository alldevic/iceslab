import { describe, it, expect } from 'vitest';
import { FORMAT_NAMES, TEMPLATE_FORMATS, TEMPLATE_TYPES } from '@iceslab/shared';

/**
 * The template types against the formats they frame.
 *
 * A template is a frame the operator writes; the format is what `/sub` answers
 * with while that template is in force. The frontend builds the editor from
 * this table, so a type pointing at a format this build cannot serve would be a
 * screen offering a template nobody can use, discovered by the operator.
 */
describe('the template formats', () => {
  it('gives every type a format', () => {
    expect(Object.keys(TEMPLATE_FORMATS).sort()).toEqual([...TEMPLATE_TYPES].sort());
  });

  it('frames only formats this build actually serves', () => {
    for (const type of TEMPLATE_TYPES) {
      expect(
        FORMAT_NAMES as readonly string[],
        `template type ${type} frames ${TEMPLATE_FORMATS[type]}, which /sub does not serve`,
      ).toContain(TEMPLATE_FORMATS[type]);
    }
  });

  it('gives every type its own format since the dialects shipped (A-236 step 4)', () => {
    // The Clash family by core; `clash` the format is the alias of mihomo and
    // is framed by mihomo templates (templateTypeForFormat), not a type's own.
    expect(TEMPLATE_FORMATS.mihomo).toBe('mihomo');
    expect(TEMPLATE_FORMATS.stash).toBe('stash');
    expect(TEMPLATE_FORMATS.clash).toBe('clash-legacy');
    expect(new Set(Object.values(TEMPLATE_FORMATS)).size).toBe(Object.keys(TEMPLATE_FORMATS).length);
    expect(TEMPLATE_FORMATS.singbox).toBe('singbox');
    expect(TEMPLATE_FORMATS['xray-json']).toBe('xrayjson');
    expect(TEMPLATE_FORMATS['xray-json-array']).toBe('xrayjson-array');
  });

  it('frames nothing that carries a single node or a single protocol', () => {
    // A template exists to arrange MANY servers: groups, rules, a selector. The
    // per-node files (wgconf, amneziavpn) and the protocol-narrow ones
    // (outline) have nothing for a frame to arrange, and a type pointing at one
    // would be an editor for a file with one line in it.
    const framed = Object.values(TEMPLATE_FORMATS);
    for (const narrow of ['wgconf', 'amneziavpn', 'outline', 'plain']) {
      expect(framed, `${narrow} cannot be framed by a template`).not.toContain(narrow);
    }
  });
});
