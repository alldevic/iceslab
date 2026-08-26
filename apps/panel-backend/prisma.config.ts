import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Loads /.env from repo root (two levels up from this file)
config({ path: "../../.env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Needed by `prisma migrate diff --from-migrations`, which replays the
    // migration directory into a throwaway database and compares the result
    // with schema.prisma. Without it the command refuses to run at all, which
    // is why the drift went unnoticed until 2026-08-26. Unset in normal use;
    // see docs/remnawave-compat.md for how to run the check and which
    // differences are Prisma's own artefacts rather than drift.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
