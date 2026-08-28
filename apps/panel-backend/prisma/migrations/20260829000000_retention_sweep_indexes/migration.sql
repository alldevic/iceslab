-- Indexes for the nightly retention sweep.
--
-- `pruneHistory` deletes by AGE alone from four history tables, and three of
-- them had no index leading with the age column: their composites lead with
-- `user_id`, which cannot serve `WHERE requested_at < X`. The fourth,
-- node_usage_history, already had `(hour DESC)` — added for the dashboard, and
-- the only one of the four that happened to serve the sweep as well.
--
-- Measured on 1M rows before adding them, in the steady state the cron actually
-- runs in (a table pruned yesterday, ~11k rows over the horizon):
--
--   seq scan            110.2 ms
--   bitmap index scan     4.6 ms
--
-- And measured for the case that does NOT need it: the first sweep of a
-- long-unpruned table deletes ~25% of it in 235 ms by seq scan, which is the
-- right plan at that selectivity. The index is for every night after that one.
--
-- CONCURRENTLY is deliberately not used: prisma migrate runs each file in one
-- transaction, and these tables are append-only history the panel can write to
-- while the index builds — a brief ACCESS EXCLUSIVE on them blocks the stats
-- poller for the build, not any user-facing read.
CREATE INDEX "subscription_request_history_requested_at_idx"
  ON "subscription_request_history" ("requested_at");

CREATE INDEX "node_user_usage_history_date_idx"
  ON "node_user_usage_history" ("date");

CREATE INDEX "subscription_events_created_at_idx"
  ON "subscription_events" ("created_at");
