ALTER TABLE "FederationPeer"
ADD COLUMN "lastErrorClass" TEXT,
ADD COLUMN "lastEmbeddingOutcome" TEXT;

ALTER TABLE "SystemSettings"
ADD COLUMN "federationInstanceName" TEXT;
