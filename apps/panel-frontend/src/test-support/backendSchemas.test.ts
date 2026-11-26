import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { CreateNodeSchema, UpdateNodeSchema } from '@backend/modules/nodes/nodes.schemas';
import { CreateUserSchema, UpdateUserSchema } from '@backend/modules/users/users.schemas';
import { CreateSquadSchema, UpdateSquadSchema } from '@backend/modules/squads/squads.schemas';
import { CreateHostSchema, UpdateHostSchema } from '@backend/modules/hosts/hosts.schemas';
import { CreateCascadeSchema, UpdateCascadeSchema } from '@backend/modules/cascades/cascade.schemas';
import { CreateSrrSchema, UpdateSrrSchema } from '@backend/modules/srr/srr.schemas';
import { UpdateSettingsSchema } from '@backend/modules/settings/settings.schemas';
import { CreateNamedOutboundSchema, UpdateNamedOutboundSchema } from '@backend/modules/named-outbounds/named-outbounds.schemas';
import { CreateNodePolicySchema, UpdateNodePolicySchema } from '@backend/modules/node-policies/node-policies.schemas';
import { frontendFilterPaths, matchesFilter } from '@/test-support/backendSource';

/**
 * The backend schemas the form tests import (milestone 17.5, through the
 * `@backend` alias of vitest.config.ts and tsconfig.app.json): each one loads
 * here and takes an object that is plainly valid, and the files they pull in
 * are the ones the `frontend` filter of ci.yml names.
 *
 * Importing the backend as code has two ways to go wrong quietly. A schema file
 * that gains an import of prisma, redis or fastify would make every form test
 * need a generated client (the `frontend` job has none). A file a schema starts
 * to import that the filter does not list would let a change to it merge without
 * the panel's tests running.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const VALID: Array<[string, ZodType, unknown]> = [
  ['CreateNodeSchema', CreateNodeSchema, { name: 'n1', address: 'node.example.test:8443' }],
  ['UpdateNodeSchema', UpdateNodeSchema, { name: 'n1' }],
  ['CreateUserSchema', CreateUserSchema, { username: 'alice' }],
  ['UpdateUserSchema', UpdateUserSchema, { description: 'x' }],
  ['CreateSquadSchema', CreateSquadSchema, { name: 'Trial' }],
  ['UpdateSquadSchema', UpdateSquadSchema, { name: 'Trial' }],
  ['CreateHostSchema', CreateHostSchema, { profileId: ID, nodeId: ID2, port: 443 }],
  ['UpdateHostSchema', UpdateHostSchema, { remark: 'x' }],
  [
    'CreateCascadeSchema',
    CreateCascadeSchema,
    { name: 'c', positions: [{ nodeIds: [ID], position: 0, entryProtocol: 'xray', linkProtocol: 'xray' }], directions: [{ countryCode: 'NL', nodeIds: [ID2] }] },
  ],
  ['UpdateCascadeSchema', UpdateCascadeSchema, { name: 'c' }],
  ['CreateSrrSchema', CreateSrrSchema, { name: 'r', uaPattern: '.*', format: 'plain' }],
  ['UpdateSrrSchema', UpdateSrrSchema, { name: 'r' }],
  ['UpdateSettingsSchema', UpdateSettingsSchema, { brandName: 'Acme' }],
  ['CreateNamedOutboundSchema', CreateNamedOutboundSchema, { name: 'exit', type: 'socks', config: { server: 'proxy.example.test', port: 1080 } }],
  ['UpdateNamedOutboundSchema', UpdateNamedOutboundSchema, { name: 'exit' }],
  ['CreateNodePolicySchema', CreateNodePolicySchema, { name: 'p', rules: [] }],
  ['UpdateNodePolicySchema', UpdateNodePolicySchema, { name: 'p' }],
];

describe('backend schemas load in the panel tests', () => {
  it.each(VALID)('%s parses a plainly valid object', (_name, schema, value) => {
    const r = schema.safeParse(value);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  });

  it.each(VALID.filter(([n]) => n.startsWith('Create') && n !== 'CreateNodePolicySchema'))('%s refuses an empty object', (_name, schema) => {
    // The control for the case above: a schema that took anything would pass it vacuously.
    expect(schema.safeParse({}).success).toBe(false);
  });
});

const SRC = import.meta.glob(['../../../panel-backend/src/**/*.ts', '!**/*.test.ts'], { query: '?raw', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;
const ROOT = '../../../panel-backend/src/';

/** `a/b/../c.js` against the directory of `from`, as a key of SRC. */
function resolveImport(from: string, spec: string): string {
  const out = from.split('/').slice(0, -1);
  for (const part of spec.replace(/\.js$/, '.ts').split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Every backend file the given ones reach through relative imports, and the non-relative modules named on the way. */
async function reach(entries: string[]): Promise<{ files: string[]; packages: Set<string> }> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const load = SRC[file];
    if (!load) throw new Error(`${file} is not under backend src, or is a test file`);
    const text = await load();
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/g)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) queue.push(resolveImport(file, spec));
      else packages.add(spec);
    }
  }
  return { files: [...seen].sort(), packages };
}

const ENTRY_FILES = [
  'nodes/nodes.schemas.ts',
  'users/users.schemas.ts',
  'squads/squads.schemas.ts',
  'hosts/hosts.schemas.ts',
  'cascades/cascade.schemas.ts',
  'srr/srr.schemas.ts',
  'settings/settings.schemas.ts',
  'named-outbounds/named-outbounds.schemas.ts',
  'node-policies/node-policies.schemas.ts',
].map((f) => `${ROOT}modules/${f}`);

describe('what the schemas pull in', () => {
  it('reaches no prisma, redis, fastify or config, and no node module but v8 and net', async () => {
    const { files, packages } = await reach(ENTRY_FILES);
    expect(files.length, 'the walk found nothing').toBeGreaterThan(ENTRY_FILES.length);
    expect(files.filter((f) => /\/(prisma|config)\.ts$|\/infra\/redis\.ts$/.test(f))).toEqual([]);
    expect([...packages].sort()).toEqual(['@iceslab/shared', 'node:net', 'node:v8', 'zod']);
  });

  it('every file reached is one the frontend filter of ci.yml names', async () => {
    const { files } = await reach(ENTRY_FILES);
    const globs = frontendFilterPaths();
    const outside = files
      .map((f) => `apps/panel-backend/src/${f.slice(ROOT.length)}`)
      .filter((p) => !matchesFilter(p, globs));
    expect(outside, 'a change to these starts no frontend job: add them to the filter in .github/workflows/ci.yml').toEqual([]);
  });
});
