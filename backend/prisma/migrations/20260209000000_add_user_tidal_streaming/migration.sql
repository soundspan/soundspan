-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "tidalOAuthJson" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "tidalStreamingQuality" TEXT NOT NULL DEFAULT 'HIGH';
