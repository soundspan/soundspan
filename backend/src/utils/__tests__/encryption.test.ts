import crypto from "crypto";

type EncryptionModule = typeof import("../encryption");

const INSECURE_DEFAULT_KEY = "default-encryption-key-change-me";
const VALID_KEY = "12345678901234567890123456789012";
const KEY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const ORIGINAL_SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

/**
 * Reproduces the historical AES-256-CBC ("v1") write format exactly, including
 * the pad-short / truncate-long key derivation, so the legacy READ path can be
 * exercised against real legacy ciphertext. The production module no longer
 * writes this format (it writes v2 GCM); legacy data must still decrypt.
 */
function legacyEncrypt(text: string, rawKey: string): string {
    const key =
        rawKey.length < 32
            ? Buffer.from(rawKey.padEnd(32, "0"))
            : Buffer.from(rawKey.slice(0, 32));
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function restoreEnvVar(
    name: "SETTINGS_ENCRYPTION_KEY" | "ENCRYPTION_KEY",
    value: string | undefined,
): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

async function loadEncryptionModule({
    settingsKey,
    fallbackKey,
}: {
    settingsKey?: string;
    fallbackKey?: string;
} = {}): Promise<EncryptionModule> {
    jest.resetModules();

    delete process.env.SETTINGS_ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;

    if (settingsKey !== undefined) {
        process.env.SETTINGS_ENCRYPTION_KEY = settingsKey;
    }

    if (fallbackKey !== undefined) {
        process.env.ENCRYPTION_KEY = fallbackKey;
    }

    return import("../encryption");
}

describe("encryption utils", () => {
    afterEach(() => {
        jest.restoreAllMocks();
        restoreEnvVar(
            "SETTINGS_ENCRYPTION_KEY",
            ORIGINAL_SETTINGS_ENCRYPTION_KEY,
        );
        restoreEnvVar("ENCRYPTION_KEY", ORIGINAL_ENCRYPTION_KEY);
        jest.resetModules();
    });

    it("throws on import when encryption keys are missing", async () => {
        await expect(loadEncryptionModule()).rejects.toThrow(
            "SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY",
        );
    });

    it("throws on import when using the insecure default key", async () => {
        await expect(
            loadEncryptionModule({ settingsKey: INSECURE_DEFAULT_KEY }),
        ).rejects.toThrow("insecure default value");
    });

    it("uses ENCRYPTION_KEY as a fallback when SETTINGS_ENCRYPTION_KEY is not set", async () => {
        const { encrypt, decrypt } = await loadEncryptionModule({
            fallbackKey: VALID_KEY,
        });

        const plaintext = "fallback-key-roundtrip";
        const encrypted = encrypt(plaintext);

        expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("returns empty string for empty encrypt/decrypt input", async () => {
        const { encrypt, decrypt } = await loadEncryptionModule({
            settingsKey: VALID_KEY,
        });

        expect(encrypt("")).toBe("");
        expect(decrypt("")).toBe("");
    });

    describe("v2 authenticated envelope (AES-256-GCM)", () => {
        it("writes the versioned v2 envelope and round-trips", async () => {
            const { encrypt, decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            const plaintext = "lidarr-api-key-secret";
            const encrypted = encrypt(plaintext);

            // v2:<saltHex>:<ivHex>:<tagHex>:<ctHex>
            expect(encrypted.startsWith("v2:")).toBe(true);
            expect(encrypted.split(":")).toHaveLength(5);
            expect(decrypt(encrypted)).toBe(plaintext);
        });

        it("produces a fresh salt+iv per call (no deterministic ciphertext)", async () => {
            const { encrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            expect(encrypt("same-input")).not.toBe(encrypt("same-input"));
        });

        it("fails CLOSED on a tampered v2 ciphertext (never returns forged cleartext)", async () => {
            const { encrypt, decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            const encrypted = encrypt("authentic-value");
            const parts = encrypted.split(":");
            // Flip the last hex nibble of the ciphertext.
            const ct = parts[4];
            const flipped =
                ct.slice(0, -1) + (ct.slice(-1) === "0" ? "1" : "0");
            const tampered = [parts[0], parts[1], parts[2], parts[3], flipped].join(
                ":",
            );

            expect(tampered).not.toBe(encrypted);
            expect(() => decrypt(tampered)).toThrow();
            // Critically, it must NOT pass the tampered value back as cleartext.
            let returned: string | undefined;
            try {
                returned = decrypt(tampered);
            } catch {
                returned = undefined;
            }
            expect(returned).toBeUndefined();
        });

        it("fails CLOSED on a tampered auth tag", async () => {
            const { encrypt, decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            const parts = encrypt("authentic-value").split(":");
            const tag = parts[3];
            parts[3] = tag.slice(0, -1) + (tag.slice(-1) === "0" ? "1" : "0");

            expect(() => decrypt(parts.join(":"))).toThrow();
        });

        it("fails CLOSED on a malformed v2 envelope (wrong part count)", async () => {
            const { decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            expect(() => decrypt("v2:only:three:parts")).toThrow();
        });

        it("fails CLOSED on a v2 envelope with a truncated auth tag", async () => {
            const { encrypt, decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            const parts = encrypt("authentic-value").split(":");
            // Truncate the 16-byte (32 hex char) tag to 12 bytes — a length GCM
            // itself would otherwise accept, weakening forgery resistance.
            parts[3] = parts[3].slice(0, 24);

            expect(() => decrypt(parts.join(":"))).toThrow("component length");
        });

        it("fails CLOSED when a v2 ciphertext is decrypted with the wrong key", async () => {
            const { encrypt } = await loadEncryptionModule({ settingsKey: KEY_A });
            const encrypted = encrypt("wrong-key-check");

            const { decrypt } = await loadEncryptionModule({ settingsKey: KEY_B });
            expect(() => decrypt(encrypted)).toThrow();
        });

        it("uses the FULL key entropy (no 32-char truncation) for v2", async () => {
            // Two keys sharing the first 32 chars but differing afterward. The
            // legacy CBC path truncated to 32 chars (so they were equivalent);
            // v2 derives via scrypt over the whole key, so they must NOT be
            // interchangeable — proving the entropy-truncation bug is gone in v2.
            const sharedPrefix = "12345678901234567890123456789012";

            const { encrypt } = await loadEncryptionModule({
                settingsKey: `${sharedPrefix}-one`,
            });
            const encrypted = encrypt("full-entropy-check");

            const { decrypt } = await loadEncryptionModule({
                settingsKey: `${sharedPrefix}-two`,
            });
            expect(() => decrypt(encrypted)).toThrow();
        });
    });

    describe("legacy v1 read path (AES-256-CBC) — historical data still decrypts", () => {
        it("decrypts legacy CBC ciphertext written before the GCM migration", async () => {
            const { decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            const legacy = legacyEncrypt("historical-secret", VALID_KEY);
            // Legacy format has no v2 prefix.
            expect(legacy.startsWith("v2:")).toBe(false);
            expect(decrypt(legacy)).toBe("historical-secret");
        });

        it("preserves the legacy truncate-long-key derivation for old data", async () => {
            // Old ciphertext written under `${prefix}-one` must still decrypt
            // under `${prefix}-two`, because the legacy derivation truncated both
            // to the same first 32 chars. This derivation must NOT be "fixed".
            const sharedPrefix = "12345678901234567890123456789012";
            const legacy = legacyEncrypt(
                "legacy-truncation",
                `${sharedPrefix}-one`,
            );

            const { decrypt } = await loadEncryptionModule({
                settingsKey: `${sharedPrefix}-two`,
            });
            expect(decrypt(legacy)).toBe("legacy-truncation");
        });

        it("throws ERR_OSSL_BAD_DECRYPT when legacy ciphertext uses the wrong key", async () => {
            const legacy = legacyEncrypt("wrong-key-check", KEY_A);

            const { decrypt } = await loadEncryptionModule({ settingsKey: KEY_B });

            let thrown: unknown;
            try {
                decrypt(legacy);
            } catch (error) {
                thrown = error;
            }
            expect((thrown as NodeJS.ErrnoException)?.code).toBe(
                "ERR_OSSL_BAD_DECRYPT",
            );
        });

        it("returns original plaintext when input is not in any encrypted format", async () => {
            const { decrypt } = await loadEncryptionModule({
                settingsKey: VALID_KEY,
            });

            expect(decrypt("already-plain-text")).toBe("already-plain-text");
        });

        it("returns original input and logs for non-decrypt legacy errors", async () => {
            jest.resetModules();
            delete process.env.SETTINGS_ENCRYPTION_KEY;
            delete process.env.ENCRYPTION_KEY;
            process.env.SETTINGS_ENCRYPTION_KEY = VALID_KEY;

            const { logger } = await import("../logger");
            const errorSpy = jest
                .spyOn(logger, "error")
                .mockImplementation(() => undefined);

            const { decrypt } = await import("../encryption");
            // Two-part, non-v2 input with an invalid (1-byte) IV → legacy CBC
            // throws a non-bad-decrypt error → logged and returned as-is.
            const malformedCipherText = "00:11";

            expect(decrypt(malformedCipherText)).toBe(malformedCipherText);
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(
                "Decryption error:",
                expect.anything(),
            );
        });
    });

    it("handles null and empty values in encryptField/decryptField", async () => {
        const { encryptField, decryptField } = await loadEncryptionModule({
            settingsKey: VALID_KEY,
        });

        expect(encryptField(null)).toBeNull();
        expect(encryptField(undefined)).toBeNull();
        expect(encryptField("")).toBeNull();
        expect(encryptField("   ")).toBeNull();

        expect(decryptField(null)).toBeNull();
        expect(decryptField(undefined)).toBeNull();
        expect(decryptField("")).toBe("");

        const encrypted = encryptField("field-value");
        expect(encrypted).not.toBeNull();
        expect(decryptField(encrypted as string)).toBe("field-value");
    });
});
