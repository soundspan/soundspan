import crypto from "crypto";
import {
    CRITICAL_SECRET_MIN_LENGTH,
    getCriticalSecretFailure,
    INSECURE_SETTINGS_ENCRYPTION_KEY,
    resolveSettingsEncryptionKey,
} from "../config/secretsPolicy";
import { isEnvFlagEnabled } from "./envParsers";
import { logger } from "./logger";

// Legacy (v1) cipher — read-only, see decryptLegacy().
const LEGACY_ALGORITHM = "aes-256-cbc";
// Current (v2) cipher — authenticated, fail-closed.
const GCM_ALGORITHM = "aes-256-gcm";
const ENVELOPE_V2 = "v2";
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12; // 96-bit nonce, the GCM standard
const GCM_TAG_BYTES = 16; // 128-bit authentication tag (GCM default)
const LEGACY_IV_BYTES = 16;

/**
 * Get and validate the raw encryption key string from the environment.
 * Throws if missing, weak, or using the insecure default.
 */
function getRawEncryptionKey(): string {
    const { value: key } = resolveSettingsEncryptionKey(process.env);

    if (!key) {
        throw new Error(
            "CRITICAL: SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY environment variable must be set.\n" +
                "This key is required to encrypt sensitive data (API keys, passwords, 2FA secrets).\n" +
                "Generate a secure key with: openssl rand -base64 32",
        );
    }

    const failure = getCriticalSecretFailure(
        key,
        INSECURE_SETTINGS_ENCRYPTION_KEY,
    );
    if (failure === "published-default") {
        throw new Error(
            "CRITICAL: Encryption key is set to the insecure default value.\n" +
                "You must set a unique SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY.\n" +
                "Generate a secure key with: openssl rand -base64 32",
        );
    }

    if (failure === "too-short") {
        throw new Error(
            `CRITICAL: Encryption key must be at least ${CRITICAL_SECRET_MIN_LENGTH} characters.\n` +
                "Generate a secure key with: openssl rand -base64 32",
        );
    }

    return key;
}

/**
 * LEGACY key derivation — DO NOT CHANGE. Reproduces the exact 32-byte key that
 * historical AES-256-CBC ("v1") ciphertext was encrypted under: keys shorter
 * than 32 chars were zero-padded, longer keys were truncated to their first 32
 * chars (so the documented `openssl rand -base64 32` lost ~12 chars of
 * entropy). "Fixing" this derivation would make all historical data
 * undecryptable. It is used ONLY to read legacy ciphertext.
 */
function deriveLegacyKey(rawKey: string): Buffer {
    if (rawKey.length < 32) {
        return Buffer.from(rawKey.padEnd(32, "0"));
    }
    return Buffer.from(rawKey.slice(0, 32));
}

let rawEncryptionKey: string | null = null;
let legacyEncryptionKey: Buffer | null = null;

/** Validates and memoizes the process encryption key. */
export function validateEncryptionKey(): void {
    if (rawEncryptionKey !== null) return;
    rawEncryptionKey = getRawEncryptionKey();
    legacyEncryptionKey = deriveLegacyKey(rawEncryptionKey);
}

function requireRawEncryptionKey(): string {
    validateEncryptionKey();
    if (rawEncryptionKey === null) {
        throw new Error("Encryption key validation did not initialize a key");
    }
    return rawEncryptionKey;
}

function requireLegacyEncryptionKey(): Buffer {
    validateEncryptionKey();
    if (legacyEncryptionKey === null) {
        throw new Error("Encryption key validation did not initialize a key");
    }
    return legacyEncryptionKey;
}

// Bounded cache of scrypt-derived v2 keys, keyed by salt hex. The derived key is
// a pure function of (RAW_ENCRYPTION_KEY, salt) and RAW_ENCRYPTION_KEY is fixed
// for the process lifetime, so memoizing by salt is safe and lets repeated reads
// of the same stored secret (e.g. the per-request Subsonic password decrypt)
// skip scrypt after the first. New/unique ciphertexts still pay scrypt once.
const GCM_KEY_CACHE = new Map<string, Buffer>();
const GCM_KEY_CACHE_MAX = 1000;

function deriveGcmKey(salt: Buffer): Buffer {
    const saltHex = salt.toString("hex");
    const cached = GCM_KEY_CACHE.get(saltHex);
    if (cached) {
        return cached;
    }
    const key = crypto.scryptSync(
        requireRawEncryptionKey(),
        salt,
        SCRYPT_KEYLEN,
    );
    if (GCM_KEY_CACHE.size >= GCM_KEY_CACHE_MAX) {
        // FIFO-evict the oldest entry to keep the cache bounded.
        const oldest = GCM_KEY_CACHE.keys().next().value;
        if (oldest !== undefined) {
            GCM_KEY_CACHE.delete(oldest);
        }
    }
    GCM_KEY_CACHE.set(saltHex, key);
    return key;
}

function legacyDecryptFailsClosed(): boolean {
    return isEnvFlagEnabled(process.env.SETTINGS_DECRYPT_FAIL_CLOSED);
}

function handleLegacyDecryptFailure(text: string, error?: unknown): string {
    if (legacyDecryptFailsClosed()) {
        if (error instanceof Error) {
            throw error;
        }
        throw new Error(
            "Legacy decryption failed closed: value is not authenticated v2 ciphertext",
        );
    }
    if (error !== undefined) {
        logger.error("Decryption error:", error);
    }
    return text;
}

/**
 * Encrypt a string with authenticated AES-256-GCM, writing the versioned
 * envelope `v2:<saltHex>:<ivHex>:<tagHex>:<ctHex>`. The key is derived per value
 * via scrypt over a random salt using the full key entropy. Returns empty string
 * for empty/null input.
 */
export function encrypt(text: string): string {
    if (!text) return "";
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const key = deriveGcmKey(salt);
    const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
        ENVELOPE_V2,
        salt.toString("hex"),
        iv.toString("hex"),
        tag.toString("hex"),
        ciphertext.toString("hex"),
    ].join(":");
}

/**
 * Decrypt a v2 (AES-256-GCM) envelope. Fails CLOSED: a malformed envelope, a
 * tampered ciphertext/tag, or the wrong key all throw — a forged value is never
 * returned as cleartext.
 */
function decryptV2(text: string): string {
    const parts = text.split(":");
    // v2:salt:iv:tag:ct — any other shape is malformed.
    if (parts.length !== 5) {
        throw new Error("Malformed v2 ciphertext envelope");
    }
    const salt = Buffer.from(parts[1], "hex");
    const iv = Buffer.from(parts[2], "hex");
    const tag = Buffer.from(parts[3], "hex");
    const ciphertext = Buffer.from(parts[4], "hex");
    // Assert the envelope component lengths rather than relying solely on the
    // GCM primitive to reject them. A full-length 128-bit tag is what gives the
    // authentication its strength; without this check, an attacker with DB write
    // access could store a truncated-tag envelope and weaken forgery resistance.
    if (
        salt.length !== SALT_BYTES ||
        iv.length !== GCM_IV_BYTES ||
        tag.length !== GCM_TAG_BYTES
    ) {
        throw new Error("Invalid v2 ciphertext envelope component length");
    }
    const key = deriveGcmKey(salt);
    const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    // .final() throws if the auth tag does not verify (tamper / wrong key).
    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);
    return decrypted.toString("utf8");
}

/**
 * Decrypt legacy v1 (AES-256-CBC) ciphertext. By default, malformed legacy data
 * retains its historical plaintext passthrough. SETTINGS_DECRYPT_FAIL_CLOSED=true
 * disables that passthrough at call time. Operators should enable the flag only
 * after GET /api/admin/secrets-status reports zero legacy rows.
 */
function decryptLegacy(text: string): string {
    const parts = text.split(":");
    if (parts.length < 2) {
        return handleLegacyDecryptFailure(text);
    }

    try {
        const iv = Buffer.from(parts[0], "hex");
        const encryptedText = Buffer.from(parts.slice(1).join(":"), "hex");
        if (iv.length !== LEGACY_IV_BYTES) {
            throw new Error("Invalid legacy ciphertext IV length");
        }
        if (
            encryptedText.length === 0 ||
            encryptedText.length % LEGACY_IV_BYTES !== 0
        ) {
            throw new Error("Invalid legacy ciphertext length");
        }
        const decipher = crypto.createDecipheriv(
            LEGACY_ALGORITHM,
            requireLegacyEncryptionKey(),
            iv,
        );
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error: any) {
        // If it's a decryption error (wrong key), throw so callers know the value is corrupt
        if (error.code === "ERR_OSSL_BAD_DECRYPT") {
            throw error;
        }
        return handleLegacyDecryptFailure(text, error);
    }
}

/**
 * Decrypt a value produced by encrypt(). Dispatches on the envelope version:
 * v2 ciphertext is authenticated and fails closed; anything else is treated as
 * legacy v1 (CBC) and read through the preserved legacy path so historical data
 * keeps decrypting during the migration. Returns empty string for empty input.
 */
export function decrypt(text: string): string {
    if (!text) return "";
    if (text.startsWith(ENVELOPE_V2 + ":")) {
        return decryptV2(text);
    }
    return decryptLegacy(text);
}

/**
 * Encrypt a field value, returning null for empty/null values
 * Useful for database fields that should store null instead of empty encrypted strings
 */
export function encryptField(value: string | null | undefined): string | null {
    if (!value || value.trim() === "") return null;
    return encrypt(value);
}

/**
 * Decrypt a field value, returning null for null values
 * Returns empty string for empty input
 */
export function decryptField(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return decrypt(value);
}
