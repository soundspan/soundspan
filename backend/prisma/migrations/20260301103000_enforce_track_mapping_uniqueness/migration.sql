-- Remove impossible orphan rows before enforcing linkage constraints.
DELETE FROM "TrackMapping"
WHERE "trackId" IS NULL
  AND "trackTidalId" IS NULL
  AND "trackYtMusicId" IS NULL;

-- Mark duplicate active linkage tuples as stale, keeping a deterministic preferred row.
WITH ranked_active AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY
                COALESCE("trackId", '__NULL__'),
                COALESCE("trackTidalId", '__NULL__'),
                COALESCE("trackYtMusicId", '__NULL__')
            ORDER BY
                CASE "source"
                    WHEN 'manual' THEN 4
                    WHEN 'isrc' THEN 3
                    WHEN 'import-match' THEN 2
                    WHEN 'gap-fill' THEN 1
                    ELSE 0
                END DESC,
                "confidence" DESC,
                "createdAt" DESC,
                "id" DESC
        ) AS row_rank
    FROM "TrackMapping"
    WHERE "stale" = false
)
UPDATE "TrackMapping" tm
SET "stale" = true
FROM ranked_active ranked
WHERE tm."id" = ranked."id"
  AND ranked.row_rank > 1;

-- Enforce linkage presence at the DB level.
ALTER TABLE "TrackMapping"
ADD CONSTRAINT "TrackMapping_requires_linkage_chk"
CHECK (
    "trackId" IS NOT NULL
    OR "trackTidalId" IS NOT NULL
    OR "trackYtMusicId" IS NOT NULL
);

-- Enforce active-row uniqueness for linkage tuple (null-safe).
CREATE UNIQUE INDEX "TrackMapping_active_linkage_tuple_unique_idx"
ON "TrackMapping" (
    COALESCE("trackId", '__NULL__'),
    COALESCE("trackTidalId", '__NULL__'),
    COALESCE("trackYtMusicId", '__NULL__')
)
WHERE "stale" = false;
