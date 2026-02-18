-- Add YouTube Music OAuth app credentials to SystemSettings
-- These are the Google API client_id and client_secret used for the device code OAuth flow
-- Admins configure these; users authenticate via device code flow
ALTER TABLE "SystemSettings" ADD COLUMN "ytMusicClientId" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "ytMusicClientSecret" TEXT;
