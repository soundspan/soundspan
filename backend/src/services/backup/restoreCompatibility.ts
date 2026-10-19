import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { BackupMigration } from "./backupFormat";

export type CompatibilityResult =
    | {
          outcome: "ok";
          migrationsToReplay: BackupMigration[];
          pendingAfterLoad: number;
          checksumWarnings: string[];
      }
    | {
          outcome: "BACKUP_NEWER_THAN_APP";
          migrationsToReplay: BackupMigration[];
          pendingAfterLoad: number;
          checksumWarnings: string[];
      };

/** Apply the same-or-newer restore rule to ordered Prisma migration inventories. */
export function evaluateRestoreCompatibility(
    backup: BackupMigration[],
    image: BackupMigration[],
): CompatibilityResult {
    const imageByName = new Map(image.map((entry) => [entry.name, entry]));
    const migrationsToReplay: BackupMigration[] = [];
    const checksumWarnings: string[] = [];
    const seen = new Set<string>();
    for (const entry of backup) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        const imageEntry = imageByName.get(entry.name);
        if (imageEntry === undefined) {
            return {
                outcome: "BACKUP_NEWER_THAN_APP",
                migrationsToReplay: [],
                pendingAfterLoad: 0,
                checksumWarnings: [],
            };
        }
        if (imageEntry.checksum !== entry.checksum) {
            checksumWarnings.push(entry.name);
        }
        migrationsToReplay.push(imageEntry);
    }
    return {
        outcome: "ok",
        migrationsToReplay,
        pendingAfterLoad:
            new Set(image.map((entry) => entry.name)).size - seen.size,
        checksumWarnings,
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
