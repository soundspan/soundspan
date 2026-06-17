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
