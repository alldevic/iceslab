import { prisma } from '../../src/prisma.js';
import { _resetBindingsCacheForTest } from '../../src/modules/subscription/subscription.bindings-cache.js';
import { invalidateSubscriptionSettingsCache } from '../../src/modules/settings/settings.service.js';

// Listed in the order they need truncating. CASCADE handles FKs but explicit
// listing is documentation. Anything that references another table comes first.
const TABLES = [
  // A4 ad-split. Missing here until 2026-07-30, which nothing noticed while the
  // module was read-only: policies are unique on both name and ordinal, so the
  // first test that CREATED one poisoned every later case in the same run.
  'group_route_policies',
  'route_policies',
  'group_cascade_exits',
  'cascade_hops',
  'cascades',
  'amneziawg_peers',
  'subscription_events',
  'subscription_request_history',
  'subscription_response_rules',
  'node_user_usage_history',
  'node_usage_history',
  'group_members',
  'group_profiles',
  'group_inbounds',
  'groups',
  'user_traffic',
  'users',
  'profile_node_bindings',
  'profiles',
  'inbounds',
  'nodes',
  'api_tokens',
  'keygen_ca',
  'admin_users',
  // Settings survived every truncate until 2026-08-26, and the table is
  // global: a test that PUT an announce template left it set for every later
  // test in the run, in every later FILE too, since the suite shares one
  // database and runs serially. Found by a test asserting the header is
  // ABSENT when no banner is configured - it saw the previous test's banner.
  'app_settings',
];

export async function cleanDatabase(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
  // B6 - the squad-set binding cache is in-process and survives a DB truncate.
  // The "All" squad below is re-seeded with a FIXED id, so without this reset a
  // later test that creates no bindings (fires no bust event) would be served a
  // prior test's cached binding-set under the same key. Treat truncation as the
  // ultimate out-of-band change and clear the cache here, per test.
  _resetBindingsCacheForTest();
  // Same reasoning for the subscription-settings cache: it is in-process with a
  // 60s TTL, so truncating the rows without clearing it would serve the next
  // test the settings of the previous one.
  invalidateSubscriptionSettingsCache();
  // Re-seed the "All" squad, slice 26 wired user-create to default to it,
  // so an empty groups table makes every user-create fail with FK violation.
  // The seed migration installs this row in production; tests truncate it
  // away each turn and need it back before the next case runs.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "groups" (id, name, description, created_at, updated_at)
    VALUES (
      '00000000-0000-0000-0000-000000000001'::uuid,
      'All',
      'Default group containing every inbound. Auto-membership for new users.',
      NOW(),
      NOW()
    )
  `);
}
