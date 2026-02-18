-- Add YouTube Music global enable toggle to SystemSettings (admin controls feature availability)
ALTER TABLE "SystemSettings" ADD COLUMN "ytMusicEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Add per-user YouTube Music OAuth credentials and quality preference to UserSettings
ALTER TABLE "UserSettings" ADD COLUMN "ytMusicOAuthJson" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "ytMusicQuality" TEXT NOT NULL DEFAULT 'HIGH';
