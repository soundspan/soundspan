-- Durable fence for retryable administrative user deletion cleanup.
ALTER TABLE "User"
ADD COLUMN "pendingDeletionAt" TIMESTAMP(3);

-- Per-record reconciliation markers let retry scans exclude completed work.
ALTER TABLE "SyncGroup"
ADD COLUMN "cleanupPublicationPending" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SyncGroupMember"
ADD COLUMN "cleanupPublicationPending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "SyncGroup_hostUserId_cleanupPublicationPending_id_idx"
ON "SyncGroup"("hostUserId", "cleanupPublicationPending", "id");

CREATE INDEX "SyncGroupMember_userId_cleanupPublicationPending_id_idx"
ON "SyncGroupMember"("userId", "cleanupPublicationPending", "id");
