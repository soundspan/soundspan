ALTER TABLE "SyncGroup"
    ADD COLUMN "groupType" TEXT NOT NULL DEFAULT 'host-follower',
    ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public',
    ADD COLUMN "stateVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SyncGroup"
    ALTER COLUMN "name" SET DEFAULT 'Listen Together';

DROP INDEX "SyncGroup_isActive_updatedAt_idx";

CREATE INDEX "SyncGroup_isActive_visibility_updatedAt_idx"
    ON "SyncGroup"("isActive", "visibility", "updatedAt");
