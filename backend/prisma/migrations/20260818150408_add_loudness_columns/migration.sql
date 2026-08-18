-- EBU R128 measurement groundwork for per-track integrated loudness and true
-- peak, plus the duration-weighted album loudness and maximum album true peak
-- aggregates described in
-- docs/designs/loudness-and-transitions.md.
--
-- All columns are nullable with no default, so this migration does not rewrite
-- existing rows or trigger the separate loudness backfill. Track.loudness is
-- the existing Essentia Steven's-law value and remains unchanged. No indexes
-- are added because these values are read per track rather than filtered.

-- AlterTable
ALTER TABLE "Album" ADD COLUMN "albumLoudnessLufs" DOUBLE PRECISION;
ALTER TABLE "Album" ADD COLUMN "albumTruePeakDb" DOUBLE PRECISION;
ALTER TABLE "Track" ADD COLUMN "loudnessLufs" DOUBLE PRECISION;
ALTER TABLE "Track" ADD COLUMN "truePeakDb" DOUBLE PRECISION;
