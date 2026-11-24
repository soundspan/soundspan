-- Admin-ordered catalog providers behind Search's Discover results.
ALTER TABLE "SystemSettings" ADD COLUMN "searchProviderOrder" TEXT NOT NULL DEFAULT 'lastfm,deezer,tidal,youtube';
ALTER TABLE "SystemSettings" ADD COLUMN "searchProvidersEnabled" TEXT NOT NULL DEFAULT 'lastfm,deezer';
