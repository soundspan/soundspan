-- Sync groups for multi-user local-track listening sessions
CREATE TABLE "SyncGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Sync Group',
    "joinCode" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trackId" TEXT,
    "queue" JSONB,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "isPlaying" BOOLEAN NOT NULL DEFAULT false,
    "currentTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stateUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncGroupMember" (
    "id" TEXT NOT NULL,
    "syncGroupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isHost" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "SyncGroupMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncGroup_joinCode_key" ON "SyncGroup"("joinCode");
CREATE INDEX "SyncGroup_hostUserId_isActive_idx" ON "SyncGroup"("hostUserId", "isActive");
CREATE INDEX "SyncGroup_isActive_updatedAt_idx" ON "SyncGroup"("isActive", "updatedAt");

CREATE UNIQUE INDEX "SyncGroupMember_syncGroupId_userId_key" ON "SyncGroupMember"("syncGroupId", "userId");
CREATE INDEX "SyncGroupMember_userId_leftAt_idx" ON "SyncGroupMember"("userId", "leftAt");
CREATE INDEX "SyncGroupMember_syncGroupId_leftAt_idx" ON "SyncGroupMember"("syncGroupId", "leftAt");

ALTER TABLE "SyncGroup"
    ADD CONSTRAINT "SyncGroup_hostUserId_fkey"
    FOREIGN KEY ("hostUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyncGroup"
    ADD CONSTRAINT "SyncGroup_trackId_fkey"
    FOREIGN KEY ("trackId") REFERENCES "Track"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SyncGroupMember"
    ADD CONSTRAINT "SyncGroupMember_syncGroupId_fkey"
    FOREIGN KEY ("syncGroupId") REFERENCES "SyncGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyncGroupMember"
    ADD CONSTRAINT "SyncGroupMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
