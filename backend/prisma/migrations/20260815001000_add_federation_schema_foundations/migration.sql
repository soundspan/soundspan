-- F1 federation schema foundations. Existing catalog rows remain local.
-- Nullable peer identity columns allow a later sync chunk to populate mirrored
-- rows without backfilling or rewriting the current library.

-- CreateEnum
CREATE TYPE "TrackOrigin" AS ENUM ('LOCAL', 'FEDERATED');
CREATE TYPE "PeerDirection" AS ENUM ('HOST', 'CONSUMER', 'BOTH');
CREATE TYPE "PeerStatus" AS ENUM ('PENDING', 'ACTIVE', 'OFFLINE', 'REVOKED');

-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN "federationInstanceId" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "catalogEpoch" TEXT;

ALTER TABLE "Artist" ADD COLUMN "peerId" TEXT;
ALTER TABLE "Artist" ADD COLUMN "remoteId" TEXT;

ALTER TABLE "Album" ADD COLUMN "peerId" TEXT;
ALTER TABLE "Album" ADD COLUMN "remoteId" TEXT;

ALTER TABLE "Track" ADD COLUMN "origin" "TrackOrigin" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "Track" ADD COLUMN "peerId" TEXT;
ALTER TABLE "Track" ADD COLUMN "remoteId" TEXT;
ALTER TABLE "Track" ALTER COLUMN "filePath" DROP NOT NULL;

-- CreateTable
CREATE TABLE "FederationPeer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "PeerDirection" NOT NULL,
    "baseUrl" TEXT,
    "credentialHash" TEXT,
    "outboundToken" TEXT,
    "scopes" TEXT[],
    "status" "PeerStatus" NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastSyncCursor" TEXT,
    "catalogEpoch" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FederationPeer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FederationTombstone" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (CONCURRENTLY cannot run inside a transaction block, so this
-- migration must remain free of explicit BEGIN/COMMIT statements.)
CREATE UNIQUE INDEX CONCURRENTLY "FederationPeer_credentialHash_key" ON "FederationPeer"("credentialHash");
CREATE UNIQUE INDEX CONCURRENTLY "Artist_peerId_remoteId_key" ON "Artist"("peerId", "remoteId");
CREATE UNIQUE INDEX CONCURRENTLY "Album_peerId_remoteId_key" ON "Album"("peerId", "remoteId");
CREATE UNIQUE INDEX CONCURRENTLY "Track_peerId_remoteId_key" ON "Track"("peerId", "remoteId");
CREATE INDEX CONCURRENTLY "Track_origin_idx" ON "Track"("origin");
CREATE INDEX CONCURRENTLY "FederationTombstone_deletedAt_idx" ON "FederationTombstone"("deletedAt");
CREATE INDEX CONCURRENTLY "FederationTombstone_entityType_entityId_idx" ON "FederationTombstone"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "FederationPeer" ADD CONSTRAINT "FederationPeer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Artist" ADD CONSTRAINT "Artist_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "FederationPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Album" ADD CONSTRAINT "Album_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "FederationPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Track" ADD CONSTRAINT "Track_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "FederationPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
