import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the one-off move from the old fork (milestone 20.3) knows about the two
 * migration chains. Data first, code second: every list here is checked by
 * catalogue.test.ts against the repository and against 040410ac itself.
 */

/** The only commit of the old fork this script takes (customer decision). */
export const OLD_COMMIT = '040410ac';

export const HERE = dirname(fileURLToPath(import.meta.url));

/** The panel-backend directory: where prisma.config.ts and prisma/ live, in the
 *  source tree (scripts/fork-migration) and in the image (dist-fork-migration/...). */
export function panelRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'prisma.config.ts'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error(`prisma.config.ts not found above ${HERE}`);
}

export const migrationsDir = (): string => join(panelRoot(), 'prisma', 'migrations');

/** A frozen file next to the code (copied beside the build in the image). */
export const dataFile = (name: string): string => join(HERE, name);

export function oldMigrationNames(): string[] {
  return readFileSync(dataFile('old-migrations.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The migrations of this repository, by name (the directory listing). */
export function omegaMigrationNames(): string[] {
  return readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Seven migrations of omega whose effect the old database already has, under
 * other names and in another form (20.3, "Цепочка миграций"): the script marks
 * them applied instead of running them. Value = the old migrations they replace.
 */
export const ANALOGS: Record<string, string[]> = {
  '20261126090000_wg_devices': [
    '20260831230000_wg_devices',
    '20260901000000_wg_device_traffic',
    '20260901070000_wg_device_preshared_key',
  ],
  '20261126110000_user_numeric_id_external_squad': [
    '20260822090000_add_user_numeric_id',
    '20260725183319_add_user_external_squad_uuid',
  ],
  '20261126120000_add_hwid_device_metadata': ['20260725183319_add_hwid_device_metadata'],
  '20261126130000_cascade_direction_label': ['20260903140000_cascade_direction_label'],
  '20261126130100_cascade_auto_label': ['20260903160000_cascade_auto_label'],
  '20261126140000_srr_wg_flavour': ['20260903120000_srr_wg_flavour'],
  '20261126150000_srr_v2rayng_plain': ['20260907120000_srr_v2rayng_plain'],
};

/** The old migrations with no analog: their effect is data the transforms take
 *  over (or a column they drop). Together with ANALOGS' values: the 15 names
 *  only the old fork has, which the script removes from the journal. */
export const OLD_ONLY_WITHOUT_ANALOG = [
  '20260822000000_add_position_node_egress_policy',
  '20260823000000_add_node_egress_tune',
  '20260826000000_clash_ua_rule_case_insensitive',
  '20260830000000_add_node_port_hopping_range',
  '20260903170000_srr_happ_xrayjson_array',
];

export const OLD_ONLY_MIGRATIONS: string[] = [...Object.values(ANALOGS).flat(), ...OLD_ONLY_WITHOUT_ANALOG].sort();

/** 48 migrations of the base plus the 6 of omega that run for real. */
export function migrationsToApply(): string[] {
  const old = new Set(oldMigrationNames());
  const analogs = new Set(Object.keys(ANALOGS));
  return omegaMigrationNames().filter((n) => !old.has(n) && !analogs.has(n));
}
