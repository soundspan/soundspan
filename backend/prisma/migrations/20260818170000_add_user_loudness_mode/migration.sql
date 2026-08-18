-- Loudness normalization design: docs/designs/loudness-and-transitions.md.
-- Maintainer decision: automatic normalization ships enabled by default.
ALTER TABLE "UserSettings"
ADD COLUMN "loudnessMode" TEXT NOT NULL DEFAULT 'auto';
