import type { Client, QueryResult } from "pg";
import { decryptWithKey, encryptWithKey } from "../../utils/encryption";
import {
    ENCRYPTED_MODEL_PRIMARY_KEYS,
    ENCRYPTED_SETTINGS_COLUMNS,
    type EncryptedModelName,
} from "../../utils/encryptedColumns";
import { quoteIdent } from "./backupCatalog";

const BATCH_SIZE = 500;
const MAX_BATCHES_PER_MODEL = 10_000_000;
const TABLE_NAMES: Record<EncryptedModelName, string> = {
    appPassword: "AppPassword",
    federationPeer: "FederationPeer",
    scrobbleConnection: "ScrobbleConnection",
    systemSettings: "SystemSettings",
    user: "User",
    userSettings: "UserSettings",
};

export type CredentialPlan =
    | { action: "reencrypt"; value: string }
    | { action: "skip-current" }
    | { action: "undecryptable" }
    | { action: "skip-empty" };

/** Decide an idempotent key rotation without changing unreadable source data. */
export function planCredentialReencryption(
    value: unknown,
    backupKey: string,
    currentKey: string,
): CredentialPlan {
    if (typeof value !== "string" || value.length === 0)
        return { action: "skip-empty" };
    if (backupKey === currentKey) return { action: "skip-current" };
    try {
        const plaintext = decryptWithKey(value, backupKey);
        return {
            action: "reencrypt",
            value: encryptWithKey(plaintext, currentKey),
        };
    } catch {
        try {
            decryptWithKey(value, currentKey);
            return { action: "skip-current" };
        } catch {
            return { action: "undecryptable" };
        }
    }
}

export interface ReencryptSummary {
    credentialsReencrypted: number;
    credentialsUndecryptable: number;
}

async function reencryptModel(
    client: Client,
    model: EncryptedModelName,
    backupKey: string,
    currentKey: string,
    summary: ReencryptSummary,
): Promise<void> {
    const table = TABLE_NAMES[model];
    const primaryKey = ENCRYPTED_MODEL_PRIMARY_KEYS[model];
    const columns = ENCRYPTED_SETTINGS_COLUMNS[model];
    let cursor: string | null = null;
    for (
        let batchNumber = 0;
        batchNumber < MAX_BATCHES_PER_MODEL;
        batchNumber += 1
    ) {
        const selected = [primaryKey, ...columns].map(quoteIdent).join(", ");
        const result: QueryResult<Record<string, unknown>> = await client.query(
            `SELECT ${selected} FROM public.${quoteIdent(table)}
              WHERE ($1::text IS NULL OR ${quoteIdent(primaryKey)}::text > $1)
              ORDER BY ${quoteIdent(primaryKey)}::text LIMIT $2`,
            [cursor, BATCH_SIZE],
        );
        if (result.rows.length === 0) return;
        for (const row of result.rows) {
            const updates: Array<{ column: string; value: string }> = [];
            for (const column of columns) {
                const plan = planCredentialReencryption(
                    row[column],
                    backupKey,
                    currentKey,
                );
                if (plan.action === "reencrypt") {
                    updates.push({ column, value: plan.value });
                    summary.credentialsReencrypted += 1;
                } else if (plan.action === "undecryptable") {
                    summary.credentialsUndecryptable += 1;
                }
            }
            for (const update of updates) {
                await client.query(
                    `UPDATE public.${quoteIdent(table)} SET ${quoteIdent(update.column)} = $1
                      WHERE ${quoteIdent(primaryKey)}::text = $2`,
                    [update.value, String(row[primaryKey])],
                );
            }
        }
        cursor = String(result.rows.at(-1)?.[primaryKey]);
        if (result.rows.length < BATCH_SIZE) return;
    }
    throw new Error("Encrypted model exceeds the supported batch limit");
}

/** Re-encrypt every registered credential column in bounded primary-key batches. */
export async function reencryptRestoredCredentials(
    client: Client,
    backupKey: string,
    currentKey: string,
): Promise<ReencryptSummary> {
    const summary: ReencryptSummary = {
        credentialsReencrypted: 0,
        credentialsUndecryptable: 0,
    };
    if (backupKey === currentKey) return summary;
    for (const model of Object.keys(
        ENCRYPTED_SETTINGS_COLUMNS,
    ) as EncryptedModelName[]) {
        await reencryptModel(client, model, backupKey, currentKey, summary);
    }
    return summary;
}
