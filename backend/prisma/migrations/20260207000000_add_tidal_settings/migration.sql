-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN     "tidalEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tidalAccessToken" TEXT,
ADD COLUMN     "tidalRefreshToken" TEXT,
ADD COLUMN     "tidalUserId" TEXT,
ADD COLUMN     "tidalCountryCode" TEXT DEFAULT 'US',
ADD COLUMN     "tidalQuality" TEXT DEFAULT 'HIGH',
ADD COLUMN     "tidalFileTemplate" TEXT DEFAULT '{album.artist}/{album.title}/{item.number:02d}. {item.title}';
