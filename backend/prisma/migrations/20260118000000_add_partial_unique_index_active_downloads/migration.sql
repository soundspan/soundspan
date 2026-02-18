-- CreateIndex
-- Partial unique index to prevent duplicate active download jobs for the same album
-- This only applies to 'pending' and 'processing' statuses, allowing multiple
-- completed/failed/exhausted downloads for the same MBID
-- Note: Prisma doesn't natively support partial indexes, so this is a raw SQL migration

CREATE UNIQUE INDEX IF NOT EXISTS "DownloadJob_targetMbid_active_unique"
ON "DownloadJob" ("targetMbid")
WHERE status IN ('pending', 'processing');

-- Add a comment explaining the index purpose
COMMENT ON INDEX "DownloadJob_targetMbid_active_unique" IS
    'Prevents duplicate download jobs for the same album when status is pending or processing. Allows multiple completed/failed downloads for retry scenarios.';
