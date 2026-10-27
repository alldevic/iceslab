-- A-236 step 2 (docs/plan/subscription-templates.md 4.2, API contract 4.5a):
-- the operator's subscription templates, a client config frame per type that
-- the panel fills with the nodes.
--
--   type   one of TEMPLATE_TYPES in @iceslab/shared; the CHECK below holds the
--          list, so a type the code does not know cannot be stored. A new
--          type is a migration of its own, on purpose.
--   name   unique within its type. "Default" is the built-in one: it is not
--          deleted, and "restore default" writes the code's body back. There
--          is no is_default column: the name is the fact, a second column
--          could disagree with it.
--   body   the frame as text (YAML or JSON by type), checked on write by the
--          API, not by the database.
--
-- No rows are written here. The Default of each type lives in the code and is
-- put in the table the first time the list is read, so the bodies are not
-- copied into SQL and the migration stays DDL only.
--
-- No database default on id: Prisma generates it (@default(uuid())), and a
-- raw-SQL default is the drift every generated draft tries to drop
-- (CLAUDE.local.md).
--
-- WRITTEN BY HAND: `migrate dev --create-only` exits on "Drift detected"
-- before drafting. `migrate status` clean before (84 migrations) and after.
--
-- Rollback:
--   DROP TABLE "subscription_templates";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023163439_subscription_templates';
-- (the way back loses every operator template; Default comes back from the
-- code on the next read once the table is created again.)

CREATE TABLE "subscription_templates" (
    "id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_templates_type_known"
      CHECK ("type" IN ('mihomo', 'stash', 'clash', 'singbox', 'xray-json-array', 'xray-json'))
);

CREATE UNIQUE INDEX "subscription_templates_type_name_key" ON "subscription_templates"("type", "name");
