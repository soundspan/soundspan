ALTER TABLE "FederationPeer"
ADD COLUMN "lastSyncSuccessAt" TIMESTAMP(3),
ADD COLUMN "lastSyncDurationMs" INTEGER,
ADD COLUMN "lastErrorAt" TIMESTAMP(3),
ADD COLUMN "lastError" TEXT;
