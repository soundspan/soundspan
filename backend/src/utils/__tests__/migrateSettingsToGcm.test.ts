import crypto from "crypto";

// The backfill script imports utils/encryption, which validates the key on load.
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "migrate-gcm-test-key-1234567890123456";

import { planColumnReencryption } from "../settingsCipherMigration";
import { isV2Envelope } from "../encryptedColumns";
import { decrypt } from "../encryption";

/** Reproduce the legacy v1 (AES-256-CBC) write format under an arbitrary key. */
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

describe("migrate-settings-to-gcm planColumnReencryption", () => {
    it("skips empty / null / non-string values", () => {
        expect(planColumnReencryption(null)).toEqual({ action: "skip-empty" });
        expect(planColumnReencryption(undefined)).toEqual({
            action: "skip-empty",
        });
        expect(planColumnReencryption("")).toEqual({ action: "skip-empty" });
        expect(planColumnReencryption(42)).toEqual({ action: "skip-empty" });
    });

    it("skips values already in the v2 envelope (idempotent re-runs)", () => {
        const alreadyV2 = "v2:aa:bb:cc:dd";
        expect(planColumnReencryption(alreadyV2)).toEqual({ action: "skip-v2" });
    });

    it("re-encrypts a previously-plaintext value into a v2 envelope", () => {
        const outcome = planColumnReencryption("plain-secret");
        expect(outcome.action).toBe("reencrypt");
        if (outcome.action !== "reencrypt") throw new Error("unreachable");
        expect(isV2Envelope(outcome.value)).toBe(true);
        // Round-trips back to the original plaintext.
        expect(decrypt(outcome.value)).toBe("plain-secret");
    });

    it("re-encrypts legacy v1 ciphertext into v2 preserving the plaintext", () => {
        // Legacy ciphertext written under the SAME key the module loaded.
        const v1 = legacyEncrypt(
            "lidarr-key",
            process.env.SETTINGS_ENCRYPTION_KEY as string
        );
        const outcome = planColumnReencryption(v1);
        expect(outcome.action).toBe("reencrypt");
        if (outcome.action !== "reencrypt") throw new Error("unreachable");
        expect(isV2Envelope(outcome.value)).toBe(true);
        expect(decrypt(outcome.value)).toBe("lidarr-key");
    });

    it("leaves undecryptable values UNTOUCHED (never rewrites garbage)", () => {
        // Legacy ciphertext under a DIFFERENT key — the module cannot decrypt it.
        const undecryptable = legacyEncrypt(
            "lost-forever",
            "a-totally-different-32byte-key-000000"
        );
        const outcome = planColumnReencryption(undecryptable);
        expect(outcome.action).toBe("skip-error");
        // Critically, no rewritten value is produced for a value we couldn't read.
        expect(outcome).not.toHaveProperty("value");
    });
});
