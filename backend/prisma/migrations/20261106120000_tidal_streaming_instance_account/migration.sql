-- Admin toggle: share the instance TIDAL account for every user's streaming.
ALTER TABLE "SystemSettings" ADD COLUMN "tidalStreamingUseInstanceAccount" BOOLEAN NOT NULL DEFAULT false;
