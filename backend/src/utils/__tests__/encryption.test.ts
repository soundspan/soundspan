type EncryptionModule = typeof import("../encryption");

const INSECURE_DEFAULT_KEY = "default-encryption-key-change-me";
const VALID_KEY = "12345678901234567890123456789012";
const KEY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const ORIGINAL_SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

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

    it("supports short keys by padding them, verified via encrypt/decrypt roundtrip", async () => {
        const { encrypt, decrypt } = await loadEncryptionModule({
            settingsKey: "short-key",
        });

        const plaintext = "short-key-roundtrip";
        const encrypted = encrypt(plaintext);

        expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("truncates long keys to 32 bytes, verified via cross-key decrypt roundtrip", async () => {
        const sharedPrefix = "12345678901234567890123456789012";

        const { encrypt } = await loadEncryptionModule({
            settingsKey: `${sharedPrefix}-one`,
        });
        const encrypted = encrypt("long-key-roundtrip");

        const { decrypt } = await loadEncryptionModule({
            settingsKey: `${sharedPrefix}-two`,
        });
        expect(decrypt(encrypted)).toBe("long-key-roundtrip");
    });

    it("returns empty string for empty encrypt/decrypt input", async () => {
        const { encrypt, decrypt } = await loadEncryptionModule({
            settingsKey: VALID_KEY,
        });

        expect(encrypt("")).toBe("");
        expect(decrypt("")).toBe("");
    });

    it("returns original plaintext when input is not in iv:ciphertext format", async () => {
        const { decrypt } = await loadEncryptionModule({
            settingsKey: VALID_KEY,
        });

        expect(decrypt("already-plain-text")).toBe("already-plain-text");
    });

    it("throws ERR_OSSL_BAD_DECRYPT when ciphertext is decrypted with the wrong key", async () => {
        const { encrypt } = await loadEncryptionModule({ settingsKey: KEY_A });
        const encrypted = encrypt("wrong-key-check");

        const { decrypt } = await loadEncryptionModule({ settingsKey: KEY_B });

        let thrown: unknown;
        try {
            decrypt(encrypted);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeDefined();
        expect((thrown as NodeJS.ErrnoException).code).toBe(
            "ERR_OSSL_BAD_DECRYPT",
        );
    });

    it("returns original input and logs for non-decrypt errors", async () => {
        jest.resetModules();
        delete process.env.SETTINGS_ENCRYPTION_KEY;
        delete process.env.ENCRYPTION_KEY;
        process.env.SETTINGS_ENCRYPTION_KEY = VALID_KEY;

        const { logger } = await import("../logger");
        const errorSpy = jest
            .spyOn(logger, "error")
            .mockImplementation(() => undefined);

        const { decrypt } = await import("../encryption");
        const malformedCipherText = "00:11";

        expect(decrypt(malformedCipherText)).toBe(malformedCipherText);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(
            "Decryption error:",
            expect.anything(),
        );
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
