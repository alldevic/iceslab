-- Remnawave-compat: a stable NUMERIC handle per user, alongside the UUID primary
-- key. Remnawave 3.0 removed `uuid` from the user object and made the integer
-- `id` the only identifier its API accepts, so a panel presenting itself as 3.x
-- must have one. BIGSERIAL creates the sequence, backfills every existing row in
-- one pass and sets NOT NULL; it rewrites the table, which is why this lands now
-- rather than under a deadline. Additive: nothing reads the column until the
-- facade is enabled and configured for the 3.x generation.
ALTER TABLE "users" ADD COLUMN "numeric_id" BIGSERIAL NOT NULL;

-- UNIQUE because the value IS an identity on the wire: the shop stores it as the
-- user's key and a duplicate would let one subscriber's write land on another.
CREATE UNIQUE INDEX "users_numeric_id_key" ON "users"("numeric_id");
