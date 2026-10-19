import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { BackupMigration } from "./backupFormat";

export type CompatibilityResult =
    | {
          outcome: "ok";
          migrationsToReplay: BackupMigration[];
          pendingAfterLoad: number;
      }
    | {
          outcome:
              | "BACKUP_NEWER_THAN_APP"
              | "BACKUP_MIGRATION_CHECKSUM_MISMATCH";
          migrationsToReplay: BackupMigration[];
          pendingAfterLoad: number;
      };

/** Apply the same-or-newer restore rule to ordered Prisma migration inventories. */
export function evaluateRestoreCompatibility(
    backup: BackupMigration[],
    image: BackupMigration[],
): CompatibilityResult {
    const imageByName = new Map(image.map((entry) => [entry.name, entry]));
    const migrationsToReplay: BackupMigration[] = [];
    for (const entry of backup) {
        const imageEntry = imageByName.get(entry.name);
        if (imageEntry === undefined) {
            return {
                outcome: "BACKUP_NEWER_THAN_APP",
                migrationsToReplay: [],
                pendingAfterLoad: 0,
            };
        }
        if (imageEntry.checksum !== entry.checksum) {
            return {
                outcome: "BACKUP_MIGRATION_CHECKSUM_MISMATCH",
                migrationsToReplay: [],
                pendingAfterLoad: 0,
            };
        }
        migrationsToReplay.push(imageEntry);
    }
    return {
        outcome: "ok",
        migrationsToReplay,
        pendingAfterLoad: image.length - backup.length,
    };
}

/** Read migration.sql files and compute Prisma's SHA-256 file-byte checksum. */
export async function readImageMigrations(
    migrationsDir: string,
): Promise<BackupMigration[]> {
    const names = (await fs.readdir(migrationsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    const migrations: BackupMigration[] = [];
    for (const name of names.slice(0, 10_000)) {
        const sql = await fs.readFile(
            path.join(migrationsDir, name, "migration.sql"),
        );
        migrations.push({
            name,
            checksum: crypto.createHash("sha256").update(sql).digest("hex"),
        });
    }
    return migrations;
}
