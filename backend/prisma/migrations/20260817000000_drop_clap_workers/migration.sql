BEGIN;

-- The torch CLAP analyzer and its runtime worker control were removed in 2.3.0.
ALTER TABLE "SystemSettings" DROP COLUMN "clapWorkers";

COMMIT;
