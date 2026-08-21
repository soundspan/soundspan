-- Reject membership commits from expired Listen Together lease holders.
ALTER TABLE "SyncGroup"
ADD COLUMN "membershipFence" BIGINT NOT NULL DEFAULT 0;
