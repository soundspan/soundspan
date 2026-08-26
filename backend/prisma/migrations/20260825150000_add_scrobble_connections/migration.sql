CREATE TABLE IF NOT EXISTS "ScrobbleConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "encryptedCredential" TEXT,
    "encryptedPendingToken" TEXT,
    "username" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScrobbleConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScrobbleConnection_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ScrobbleConnection_service_check'
          AND conrelid = '"ScrobbleConnection"'::regclass
    ) THEN
        ALTER TABLE "ScrobbleConnection"
        ADD CONSTRAINT "ScrobbleConnection_service_check"
        CHECK ("service" IN ('lastfm', 'listenbrainz'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ScrobbleConnection_userId_service_key"
ON "ScrobbleConnection"("userId", "service");

CREATE INDEX IF NOT EXISTS "ScrobbleConnection_userId_idx"
ON "ScrobbleConnection"("userId");
