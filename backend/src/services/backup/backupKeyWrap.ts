import crypto from "crypto";
import {
    BACKUP_FORMAT_MAGIC,
    BACKUP_FORMAT_VERSION,
    wrappedEncryptionKeySchema,
    type WrappedEncryptionKey,
} from "./backupFormat";
import { BackupPassphraseError } from "./backupErrors";
import { z } from "zod";
export { BackupPassphraseError } from "./backupErrors";

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PASSPHRASE_CHARACTERS = 12;
const MAX_PASSPHRASE_CHARACTERS = 1024;
const SCRYPT_OPTIONS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const AAD = Buffer.from(`${BACKUP_FORMAT_MAGIC}:${BACKUP_FORMAT_VERSION}`);
const WRAP_INFO = Buffer.from("soundspan-backup-v1 key-wrap");
const MAC_INFO = Buffer.from("soundspan-backup-v1 mac");
const wrappedPayloadSchema = z
    .object({
        key: z.string().min(1).max(10_000),
        pepperFingerprint: z.string().max(256).nullable(),
    })
    .strict();

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            passphrase,
            salt,
            KEY_BYTES,
            SCRYPT_OPTIONS,
            (error, derivedKey) => {
                if (error) reject(error);
                else resolve(derivedKey);
            },
        );
    });
}

function expandKey(key: Buffer, info: Buffer): Buffer {
    return Buffer.from(
        crypto.hkdfSync("sha256", key, Buffer.alloc(0), info, KEY_BYTES),
    );
}

export interface WrappedBackupSecrets {
    wrappedKey: WrappedEncryptionKey;
    macKey: Buffer;
}

export interface UnwrappedBackupSecrets {
    key: string;
    pepperFingerprint: string | null;
    macKey: Buffer;
}

function validatePassphrase(passphrase: string): void {
    if (
        passphrase.length < MIN_PASSPHRASE_CHARACTERS ||
        passphrase.length > MAX_PASSPHRASE_CHARACTERS
    ) {
        throw new BackupPassphraseError();
    }
}

/** Wrap a deployment encryption key without exposing it in the archive header. */
export async function wrapEncryptionKey(
    key: string,
    passphrase: string,
    pepperFingerprint: string | null,
): Promise<WrappedBackupSecrets> {
    validatePassphrase(passphrase);
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const rootKey = await deriveKey(passphrase, salt);
    const wrappingKey = expandKey(rootKey, WRAP_INFO);
    const macKey = expandKey(rootKey, MAC_INFO);
    const cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ key, pepperFingerprint }), "utf8"),
        cipher.final(),
    ]);
    return {
        wrappedKey: {
            salt: salt.toString("base64"),
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            ciphertext: ciphertext.toString("base64"),
        },
        macKey,
    };
}

function decodeWrapped(wrapped: WrappedEncryptionKey): {
    salt: Buffer;
    iv: Buffer;
    tag: Buffer;
    ciphertext: Buffer;
} {
    const parsed = wrappedEncryptionKeySchema.parse(wrapped);
    for (const value of Object.values(parsed)) {
        if (Buffer.from(value, "base64").toString("base64") !== value) {
            throw new Error("Wrapped-key field is not canonical base64");
        }
    }
    const decoded = {
        salt: Buffer.from(parsed.salt, "base64"),
        iv: Buffer.from(parsed.iv, "base64"),
        tag: Buffer.from(parsed.tag, "base64"),
        ciphertext: Buffer.from(parsed.ciphertext, "base64"),
    };
    if (
        decoded.salt.length !== SALT_BYTES ||
        decoded.iv.length !== IV_BYTES ||
        decoded.tag.length !== TAG_BYTES
    ) {
        throw new Error("Invalid wrapped-key component length");
    }
    return decoded;
}

/** Unwrap a deployment key; all malformed/tampered inputs map to one safe error. */
export async function unwrapEncryptionKey(
    wrapped: WrappedEncryptionKey,
    passphrase: string,
): Promise<UnwrappedBackupSecrets> {
    try {
        validatePassphrase(passphrase);
        const decoded = decodeWrapped(wrapped);
        const rootKey = await deriveKey(passphrase, decoded.salt);
        const wrappingKey = expandKey(rootKey, WRAP_INFO);
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            wrappingKey,
            decoded.iv,
        );
        decipher.setAAD(AAD);
        decipher.setAuthTag(decoded.tag);
        const plaintext = Buffer.concat([
            decipher.update(decoded.ciphertext),
            decipher.final(),
        ]).toString("utf8");
        const payload = wrappedPayloadSchema.parse(
            JSON.parse(plaintext) as unknown,
        );
        return {
            ...payload,
            macKey: expandKey(rootKey, MAC_INFO),
        };
    } catch (cause) {
        throw new BackupPassphraseError({ cause });
    }
}
