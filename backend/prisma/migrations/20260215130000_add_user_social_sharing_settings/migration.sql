ALTER TABLE "UserSettings"
ADD COLUMN "shareOnlinePresence" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "shareListeningStatus" BOOLEAN NOT NULL DEFAULT false;
