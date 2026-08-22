ALTER TABLE "UserSettings"
ADD COLUMN "sharePresenceToPeers" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SystemSettings"
ADD COLUMN "federationShowPeerStatus" BOOLEAN NOT NULL DEFAULT false;
