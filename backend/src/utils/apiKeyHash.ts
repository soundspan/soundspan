import { createHmac } from "crypto";

/**
 * API keys are stored as a keyed hash (HMAC-SHA256) at rest, so a read-only DB
 * exposure (pg_dump, replica, raw-query slip) yields only hashes, not working
 * credentials. Validation hashes the presented key and looks it up by hash.
 *
 * A raw device key and its HMAC are both 64 hex chars, so stored hashes are
 * prefixed (`hmac:<hex>`) to be self-describing: the backfill and the
 * secrets-status check use the prefix to tell migrated rows from legacy
 * plaintext ones (which have no prefix). The `key` column stays `@unique` —
 * HMAC is deterministic, so each raw key maps to exactly one stored value.
 */
export const HASHED_KEY_PREFIX = "hmac:";

/**
 * Resolve the HMAC pepper. Prefers a dedicated `API_KEY_PEPPER` (Helm-managed,
 * stabilized like the other secrets), falling back to `SETTINGS_ENCRYPTION_KEY`
 * then `SESSION_SECRET` so the hash is always keyed without requiring a new env
 * var. Whichever is chosen MUST stay stable — changing it invalidates every
 * already-hashed key (the keys would need re-issuing).
 */
function getPepper(): string {
    const pepper =
        process.env.API_KEY_PEPPER ||
        process.env.SETTINGS_ENCRYPTION_KEY ||
        process.env.SESSION_SECRET;
    if (!pepper) {
        throw new Error(
            "API_KEY_PEPPER, SETTINGS_ENCRYPTION_KEY, or SESSION_SECRET must be set to hash API keys at rest"
        );
    }
    return pepper;
}

/**
 * Name of the env var the pepper resolved from (not its value). Lets the
 * backfill log which source is in effect so a silent fallback / mismatch is
 * easy to spot operationally. Returns null if none is configured.
 */
export function getPepperSource(): string | null {
    if (process.env.API_KEY_PEPPER) return "API_KEY_PEPPER";
    if (process.env.SETTINGS_ENCRYPTION_KEY) return "SETTINGS_ENCRYPTION_KEY";
    if (process.env.SESSION_SECRET) return "SESSION_SECRET";
    return null;
}

/** The at-rest stored form of an API key: `hmac:` + HMAC-SHA256(rawKey, pepper). */
export function hashApiKey(rawKey: string): string {
    return (
        HASHED_KEY_PREFIX +
        createHmac("sha256", getPepper()).update(rawKey).digest("hex")
    );
}

/** Whether a stored value is already a hashed key (vs a legacy plaintext key). */
export function isHashedApiKey(stored: string | null | undefined): boolean {
    return typeof stored === "string" && stored.startsWith(HASHED_KEY_PREFIX);
}

/**
 * Look up an API key record by its raw value, trying the hashed form first
 * (current) then the raw value (transitional — keys not yet migrated by the
 * backfill are still stored verbatim). This is the dual-validate grace window:
 * existing keys keep working with no re-issue. Remove the raw fallback once the
 * backfill has migrated every key (verify via GET /api/admin/secrets-status).
 */
export async function findApiKeyRecord<R>(
    rawKey: string,
    lookup: (storedKey: string) => Promise<R | null>
): Promise<R | null> {
    const byHash = await lookup(hashApiKey(rawKey));
    if (byHash) return byHash;
    // Guard the transitional raw-key fallback: a legitimate raw key is never in
    // the `hmac:` stored form, so refuse to look one up verbatim. Without this, an
    // attacker who leaked the DB could present a stored hash (`hmac:<h>`) as the
    // key and the raw lookup would match it — defeating at-rest hashing.
    if (isHashedApiKey(rawKey)) return null;
    return lookup(rawKey);
}

export type ApiKeyHashOutcome =
    | { action: "skip-hashed" }
    | { action: "hash"; value: string };

/**
 * Decide what the F28 backfill should do with one stored `ApiKey.key`:
 * already-hashed rows are skipped (idempotent re-runs), legacy plaintext rows
 * are hashed in place. The stored plaintext value IS the raw key, so hashing it
 * yields the value that the dual-validate lookup will then match.
 */
export function planApiKeyHashing(storedKey: string): ApiKeyHashOutcome {
    if (isHashedApiKey(storedKey)) {
        return { action: "skip-hashed" };
    }
    return { action: "hash", value: hashApiKey(storedKey) };
}
