-- Build indexes for recurring worker, library, radio, playlist, and
-- notification query shapes. New indexes build CONCURRENTLY so writes are
-- never blocked (this file must therefore remain free of explicit
-- BEGIN/COMMIT statements, matching the Track_random_idx precedent).
-- Drops are plain DROP INDEX: DROP INDEX CONCURRENTLY fails under
-- prisma migrate deploy's statement runner (verified against a scratch
-- database), and dropping a never-scanned ~3MB index holds its lock for
-- only a moment.

-- CreateIndex (re-runnable: a failed CONCURRENTLY build leaves an INVALID
-- index under the target name; drop any leftover before rebuilding)
DROP INDEX IF EXISTS "Track_vibeAnalysisStatus_idx";
CREATE INDEX CONCURRENTLY "Track_vibeAnalysisStatus_idx"
ON "Track"("vibeAnalysisStatus");

-- CreateIndex (re-runnable: a failed CONCURRENTLY build leaves an INVALID
-- index under the target name; drop any leftover before rebuilding)
DROP INDEX IF EXISTS "LikedTrack_userId_likedAt_idx";
CREATE INDEX CONCURRENTLY "LikedTrack_userId_likedAt_idx"
ON "LikedTrack"("userId", "likedAt");

-- CreateIndex (re-runnable: a failed CONCURRENTLY build leaves an INVALID
-- index under the target name; drop any leftover before rebuilding)
DROP INDEX IF EXISTS "Track_analysisStatus_origin_removedAt_idx";
CREATE INDEX CONCURRENTLY "Track_analysisStatus_origin_removedAt_idx"
ON "Track"("analysisStatus", "origin", "removedAt");

-- CreateIndex (re-runnable: a failed CONCURRENTLY build leaves an INVALID
-- index under the target name; drop any leftover before rebuilding)
DROP INDEX IF EXISTS "Notification_userId_cleared_createdAt_idx";
CREATE INDEX CONCURRENTLY "Notification_userId_cleared_createdAt_idx"
ON "Notification"("userId", "cleared", "createdAt");

-- DropIndex
DROP INDEX IF EXISTS "Track_acousticness_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_arousal_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_bpm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_danceability_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_energy_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_instrumentalness_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_valence_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodAcoustic_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodAggressive_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodElectronic_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodHappy_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodParty_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodRelaxed_idx";

-- DropIndex
DROP INDEX IF EXISTS "Track_moodSad_idx";
