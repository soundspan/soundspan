import { encrypt, decrypt } from "./encryption";
import { isV2Envelope } from "./encryptedColumns";

/**
 * Pure decision logic for the F29 settings-cipher backfill (v1 AES-CBC → v2
 * AES-GCM). Extracted from `scripts/migrate-settings-to-gcm.ts` so it can be
 * unit-tested inside the compiled source tree. No DB access.
 */
export type ReencryptOutcome =
    | { action: "skip-empty" }
    | { action: "skip-v2" }
    | { action: "reencrypt"; value: string }
    | { action: "skip-error"; error: unknown };

/**
 * Decide what to do with one stored column value. The skip-on-error branch is
 * the critical safety property: a value that cannot be decrypted (wrong/lost
 * key, corruption) is left UNTOUCHED rather than re-wrapped into garbage v2
 * ciphertext.
 */
export function planColumnReencryption(value: unknown): ReencryptOutcome {
    if (typeof value !== "string" || value.length === 0) {
        return { action: "skip-empty" };
    }
    if (isV2Envelope(value)) {
        return { action: "skip-v2" };
    }
    try {
        // decrypt handles v1 ciphertext and plaintext passthrough;
        // encrypt writes the v2 envelope.
        return { action: "reencrypt", value: encrypt(decrypt(value)) };
    } catch (error) {
        return { action: "skip-error", error };
    }
}

/** The subset of a Prisma model delegate the backfill needs. */
export interface EncryptedModelDelegate {
    findMany(args: {
        select: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>>;
    update(args: {
        where: Record<string, unknown>;
        data: Record<string, string>;
    }): Promise<unknown>;
}

export interface ModelMigrationStats {
    rows: number;
    reencrypted: number;
    alreadyV2: number;
    skippedErrors: number;
}

/**
 * Re-encrypt every tracked column of one model from the legacy v1 envelope to
 * v2. Rows are selected and updated by `primaryKey` (per-model — see
 * `ENCRYPTED_MODEL_PRIMARY_KEYS`). When `apply` is false this is a dry run:
 * outcomes are counted but nothing is written.
 */
export async function migrateModelRows(
    modelName: string,
    delegate: EncryptedModelDelegate,
    columns: readonly string[],
    primaryKey: string,
    apply: boolean,
    warn: (message: string) => void = console.warn
): Promise<ModelMigrationStats> {
    const stats: ModelMigrationStats = {
        rows: 0,
        reencrypted: 0,
        alreadyV2: 0,
        skippedErrors: 0,
    };

    const select: Record<string, boolean> = { [primaryKey]: true };
    for (const column of columns) select[column] = true;

    const rows = await delegate.findMany({ select });

    for (const row of rows) {
        stats.rows += 1;
        const data: Record<string, string> = {};

        for (const column of columns) {
            const outcome = planColumnReencryption(row[column]);
            if (outcome.action === "reencrypt") {
                data[column] = outcome.value;
            } else if (outcome.action === "skip-v2") {
                stats.alreadyV2 += 1;
            } else if (outcome.action === "skip-error") {
                stats.skippedErrors += 1;
                warn(
                    `[migrate-gcm] ${modelName}.${column} (${primaryKey}=${String(
                        row[primaryKey]
                    )}) could not be decrypted; leaving as-is: ${
                        outcome.error instanceof Error
                            ? outcome.error.message
                            : String(outcome.error)
                    }`
                );
            }
        }

        const changed = Object.keys(data).length;
        if (changed === 0) continue;
        stats.reencrypted += changed;
        if (apply) {
            await delegate.update({
                where: { [primaryKey]: row[primaryKey] },
                data,
            });
        }
    }

    return stats;
}
