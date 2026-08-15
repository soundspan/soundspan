-- F2 federation pairing codes. This is expand-only: it creates a new table
-- and leaves every existing row and contract unchanged.
CREATE TABLE "FederationPairingCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationPairingCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX CONCURRENTLY "FederationPairingCode_code_key" ON "FederationPairingCode"("code");
CREATE INDEX CONCURRENTLY "FederationPairingCode_code_expiresAt_idx" ON "FederationPairingCode"("code", "expiresAt");
CREATE INDEX CONCURRENTLY "FederationPairingCode_createdById_idx" ON "FederationPairingCode"("createdById");

ALTER TABLE "FederationPairingCode" ADD CONSTRAINT "FederationPairingCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
