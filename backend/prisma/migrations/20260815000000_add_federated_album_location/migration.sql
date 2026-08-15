-- F1 federation schema foundations: extend AlbumLocation separately from the
-- remaining DDL. PostgreSQL versions that permit ALTER TYPE ... ADD VALUE in
-- a transaction still cannot use the new value until that transaction commits.
-- Keeping this migration isolated makes that commit boundary explicit.

-- AlterEnum
ALTER TYPE "AlbumLocation" ADD VALUE 'FEDERATED';
