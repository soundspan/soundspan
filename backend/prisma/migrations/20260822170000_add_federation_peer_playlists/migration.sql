ALTER TABLE "UserSettings"
ADD COLUMN "sharePlaylistsToPeers" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FederationPlaylistFollow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationPlaylistFollow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FederationPlaylistFollow_userId_peerId_remoteId_key"
ON "FederationPlaylistFollow"("userId", "peerId", "remoteId");

CREATE INDEX "FederationPlaylistFollow_userId_createdAt_idx"
ON "FederationPlaylistFollow"("userId", "createdAt");

CREATE INDEX "FederationPlaylistFollow_peerId_idx"
ON "FederationPlaylistFollow"("peerId");

ALTER TABLE "FederationPlaylistFollow"
ADD CONSTRAINT "FederationPlaylistFollow_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FederationPlaylistFollow"
ADD CONSTRAINT "FederationPlaylistFollow_peerId_fkey"
FOREIGN KEY ("peerId") REFERENCES "FederationPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
