ALTER TABLE "SystemSettings"
ADD COLUMN "playbackSourceOrder" TEXT NOT NULL DEFAULT 'library,peers,tidal,ytmusic';
