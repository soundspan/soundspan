-- F14 adds per-peer duplicate visibility and host stream caps plus a durable
-- manual-arbitration pin. Defaults preserve every existing peer and track.

ALTER TABLE "FederationPeer"
    ADD COLUMN "showDedupedCopies" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "maxConcurrentStreams" INTEGER,
    ADD COLUMN "maxStreamKbps" INTEGER;

ALTER TABLE "Track"
    ADD COLUMN "dedupPinned" BOOLEAN NOT NULL DEFAULT false;
