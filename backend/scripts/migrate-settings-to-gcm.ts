#!/usr/bin/env ts-node
/**
 * F29 backfill: re-encrypt every settings-cipher column from the legacy v1
 * (AES-256-CBC) envelope to the authenticated v2 (AES-256-GCM) envelope.
 *
 * The app already reads both formats and writes v2 on every save, so this is an
 * acceleration step: it forces every at-rest value onto the strong cipher so
 * nothing lingers on v1 (after which the legacy read path can eventually be
 * removed). For each tracked column it does `encrypt(decrypt(value))`:
 *   - legacy v1 ciphertext → decrypts via the preserved CBC path → re-encrypts v2
 *   - previously-unencrypted passthrough values → encrypted as v2
 *   - already-v2 values → skipped
 *   - undecryptable values (wrong/lost key) → logged and SKIPPED, never rewritten
 *
 * Forward-only and idempotent (safe to re-run). DEFAULTS TO DRY-RUN — pass
 * `--apply` to actually write. Requires SETTINGS_ENCRYPTION_KEY (or
 * ENCRYPTION_KEY) in the environment, the same key the app runs with.
 *
 *   npx tsx scripts/migrate-settings-to-gcm.ts            # dry run (no writes)
 *   npx tsx scripts/migrate-settings-to-gcm.ts --apply    # perform the migration
 *
 * ⚠️  Destructive (rewrites secret columns). Take a database backup first.
 */
import { createPrismaClient } from "../src/utils/prismaClientFactory";
import {
    ENCRYPTED_MODEL_PRIMARY_KEYS,
    ENCRYPTED_SETTINGS_COLUMNS,
    type EncryptedModelName,
} from "../src/utils/encryptedColumns";
import {
    migrateModelRows,
    type EncryptedModelDelegate,
    type ModelMigrationStats,
} from "../src/utils/settingsCipherMigration";

const prisma = createPrismaClient();

function emptyStats(): ModelMigrationStats {
    return { rows: 0, reencrypted: 0, alreadyV2: 0, skippedErrors: 0 };
}

async function migrateModel(
    modelName: EncryptedModelName,
    columns: readonly string[],
    apply: boolean
): Promise<ModelMigrationStats> {
    // Dynamic delegate access — this is a one-off migration over a small set of
    // hand-listed models, not runtime app code.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[modelName] as
        | EncryptedModelDelegate
        | undefined;
    if (!delegate?.findMany) {
        console.warn(`[migrate-gcm] unknown model "${modelName}", skipping`);
        return emptyStats();
    }

    // Rows are keyed by the model's REAL primary key (userSettings uses
    // `userId`, not `id`) — the row loop lives in the unit-tested
    // settingsCipherMigration module.
    const stats = await migrateModelRows(
        modelName,
        delegate,
        columns,
        ENCRYPTED_MODEL_PRIMARY_KEYS[modelName],
        apply
    );

    console.log(
        `[migrate-gcm] ${modelName}: rows=${stats.rows} reencrypted=${stats.reencrypted} alreadyV2=${stats.alreadyV2} skippedErrors=${stats.skippedErrors}`
    );
    return stats;
}

async function run(apply: boolean): Promise<void> {
    console.log(
        `[migrate-gcm] starting settings v1→v2 re-encryption (${apply ? "APPLY — writing" : "DRY RUN — no writes"})`
    );

    const totals = emptyStats();
    for (const modelName of Object.keys(
        ENCRYPTED_SETTINGS_COLUMNS
    ) as EncryptedModelName[]) {
        const columns = ENCRYPTED_SETTINGS_COLUMNS[modelName];
        const stats = await migrateModel(modelName, columns, apply);
        totals.rows += stats.rows;
        totals.reencrypted += stats.reencrypted;
        totals.alreadyV2 += stats.alreadyV2;
        totals.skippedErrors += stats.skippedErrors;
    }

    console.log(
        `[migrate-gcm] ${apply ? "complete" : "dry run complete"}: rows=${totals.rows} reencrypted=${totals.reencrypted} alreadyV2=${totals.alreadyV2} skippedErrors=${totals.skippedErrors}`
    );
    if (!apply && totals.reencrypted > 0) {
        console.log(
            "[migrate-gcm] re-run with --apply to write these changes (back up the database first)."
        );
    }
}

// Only execute when run directly (npx tsx scripts/migrate-settings-to-gcm.ts),
// not when imported by a test of planColumnReencryption().
if (require.main === module) {
    const apply = process.argv.slice(2).includes("--apply");

    run(apply)
        .catch((error) => {
            console.error("[migrate-gcm] failed", error);
            process.exitCode = 1;
        })
        .finally(async () => {
            await prisma.$disconnect();
        });
}
