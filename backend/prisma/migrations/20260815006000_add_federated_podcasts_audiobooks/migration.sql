-- F13 adds podcast catalog listings and full audiobook mirrors without
-- rewriting existing Podcast or Audiobook rows.

-- AlterTable
ALTER TABLE "Audiobook" ADD COLUMN "peerId" TEXT;
ALTER TABLE "Audiobook" ADD COLUMN "remoteId" TEXT;

-- CreateTable
CREATE TABLE "FederationPodcastListing" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "imageUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FederationPodcastListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (CONCURRENTLY cannot run inside a transaction block, so this
-- migration must remain free of explicit BEGIN/COMMIT statements.)
CREATE UNIQUE INDEX CONCURRENTLY "Audiobook_peerId_remoteId_key"
    ON "Audiobook"("peerId", "remoteId");
CREATE UNIQUE INDEX CONCURRENTLY "FederationPodcastListing_peerId_remoteId_key"
    ON "FederationPodcastListing"("peerId", "remoteId");
CREATE INDEX CONCURRENTLY "FederationPodcastListing_feedUrl_idx"
    ON "FederationPodcastListing"("feedUrl");

-- AddForeignKey
ALTER TABLE "Audiobook"
    ADD CONSTRAINT "Audiobook_peerId_fkey"
    FOREIGN KEY ("peerId") REFERENCES "FederationPeer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationPodcastListing"
    ADD CONSTRAINT "FederationPodcastListing_peerId_fkey"
    FOREIGN KEY ("peerId") REFERENCES "FederationPeer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
