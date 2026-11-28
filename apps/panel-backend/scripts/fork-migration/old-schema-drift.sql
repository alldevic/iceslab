-- The difference between a database built by the 65 migrations of 040410ac and old-schema.prisma.
-- A pristine old install carries it (the base reconciled it later, 20261029064640_reconcile_drift),
-- so the pre-check expects exactly this and anything else is drift by hand.
-- Regenerate: prisma migrate diff --from-config-datasource --to-schema old-schema.prisma --script on a database built from the 65 migrations (fixtures/make-old-baseline.sh builds one).
ALTER TABLE "amneziawg_peers" ADD CONSTRAINT "amneziawg_peers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "amneziawg_peers" DROP CONSTRAINT "amneziawg_peers_profile_id_fkey";
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_created_by_admin_id_fkey";
ALTER TABLE "group_profiles" ADD CONSTRAINT "group_profiles_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_profiles" ADD CONSTRAINT "group_profiles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_profiles" DROP CONSTRAINT "group_profiles_group_id_fkey";
ALTER TABLE "group_profiles" DROP CONSTRAINT "group_profiles_profile_id_fkey";
ALTER TABLE "hosts" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "hwid_user_devices" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "profile_node_bindings" ADD CONSTRAINT "profile_node_bindings_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profile_node_bindings" ADD CONSTRAINT "profile_node_bindings_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "profile_node_bindings" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "profile_node_bindings" DROP CONSTRAINT "profile_node_bindings_node_id_fkey";
ALTER TABLE "profile_node_bindings" DROP CONSTRAINT "profile_node_bindings_profile_id_fkey";
ALTER TABLE "profiles" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "regions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_policies" ALTER COLUMN "direct_domains" DROP DEFAULT, ALTER COLUMN "block_domains" DROP DEFAULT;
