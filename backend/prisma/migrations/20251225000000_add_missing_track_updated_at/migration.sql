-- Add updatedAt column to Track if it doesn't exist
-- This handles databases that were created before this column was added to the schema

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Track' AND column_name = 'updatedAt'
    ) THEN
        ALTER TABLE "Track" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;
