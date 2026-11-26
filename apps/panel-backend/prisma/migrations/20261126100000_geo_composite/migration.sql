-- Milestone 10.2: a fourth kind of geo set, built from categories of other
-- sets and from entries typed by hand. The definition is a JSON list of
-- categories; the built file is an ordinary version in geo_set_versions.
ALTER TABLE "geo_sets" ADD COLUMN "composite_def" JSONB;

ALTER TABLE "geo_sets" DROP CONSTRAINT "geo_sets_source_type_check";
ALTER TABLE "geo_sets" ADD CONSTRAINT "geo_sets_source_type_check" CHECK ("source_type" IN ('builtin', 'url', 'upload', 'composite'));
