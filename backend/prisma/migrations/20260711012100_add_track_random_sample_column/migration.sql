-- F15: indexed pivot-sample column for GET /tracks/shuffle's large-library
-- branch, replacing a full-table `ORDER BY RANDOM()` scan+sort.
--
-- NOTE: `prisma migrate dev`'s auto-diff against this branch's schema.prisma
-- also proposed several unrelated statements (DROP INDEX on
-- track_embeddings' ivfflat index, default/nullability changes on Bookmark,
-- LibraryHealthRecord, SystemSettings, and Track.vibeAnalysis* columns).
-- Those reflect pre-existing drift between schema.prisma and the migration
-- history already present on this integration branch (dc2735e) — none of it
-- is caused by or in scope for this change (the track_embeddings index in
-- particular is an Unsupported()-column ivfflat index that Prisma's DSL
-- cannot represent, so its diff engine proposes dropping it any time
-- `migrate dev` runs here; that's pre-existing and not F15's concern). This
-- migration intentionally contains ONLY the F15 change.
--
-- PG16 note: unlike a constant-default ADD COLUMN (metadata-only, instant),
-- a VOLATILE default (`random()`) forces Postgres to rewrite the whole table
-- to populate every existing row. At this corpus size (15,230 Track rows)
-- that rewrite is milliseconds; see the benchmark in the PR for timing. This
-- is a one-time cost at deploy time, not a per-request cost.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "random" DOUBLE PRECISION NOT NULL DEFAULT random();

-- CreateIndex
CREATE INDEX "Track_random_idx" ON "Track"("random");
