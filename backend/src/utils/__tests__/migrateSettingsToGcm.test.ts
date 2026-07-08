import crypto from "crypto";

// The backfill script imports utils/encryption, which validates the key on load.
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "migrate-gcm-test-key-1234567890123456";

import {
    migrateModelRows,
    planColumnReencryption,
} from "../settingsCipherMigration";
import {
    ENCRYPTED_MODEL_PRIMARY_KEYS,
    ENCRYPTED_SETTINGS_COLUMNS,
    isV2Envelope,
} from "../encryptedColumns";
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

describe("migrate-settings-to-gcm migrateModelRows", () => {
    /** Minimal in-memory stand-in for a Prisma model delegate. */
    function fakeDelegate(rows: Array<Record<string, unknown>>) {
        const findManyCalls: Array<{ select: Record<string, boolean> }> = [];
        const updateCalls: Array<{
            where: Record<string, unknown>;
            data: Record<string, string>;
        }> = [];
        return {
            findManyCalls,
            updateCalls,
            delegate: {
                findMany: async (args: { select: Record<string, boolean> }) => {
                    findManyCalls.push(args);
                    return rows;
                },
                update: async (args: {
                    where: Record<string, unknown>;
                    data: Record<string, string>;
                }) => {
                    updateCalls.push(args);
                    return args;
                },
            },
        };
    }

    it("declares a primary key for every model in the encrypted-columns inventory", () => {
        for (const modelName of Object.keys(ENCRYPTED_SETTINGS_COLUMNS)) {
            expect(ENCRYPTED_MODEL_PRIMARY_KEYS).toHaveProperty(modelName);
        }
    });

    it("selects and updates userSettings by its real primary key (userId, not id)", async () => {
        // Regression: UserSettings has NO `id` column (PK is `userId`); a
        // hardcoded `{ id: true }` select makes Prisma throw and aborts the
        // migration between models.
        const { delegate, findManyCalls, updateCalls } = fakeDelegate([
            { userId: "u1", ytMusicOAuthJson: "plaintext-oauth-blob" },
        ]);

        const stats = await migrateModelRows(
            "userSettings",
            delegate,
            ENCRYPTED_SETTINGS_COLUMNS.userSettings,
            ENCRYPTED_MODEL_PRIMARY_KEYS.userSettings,
            true
        );

        expect(findManyCalls[0].select).toMatchObject({
            userId: true,
            ytMusicOAuthJson: true,
            tidalOAuthJson: true,
        });
        expect(findManyCalls[0].select).not.toHaveProperty("id");
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].where).toEqual({ userId: "u1" });
        expect(isV2Envelope(updateCalls[0].data.ytMusicOAuthJson)).toBe(true);
        expect(stats).toMatchObject({ rows: 1, reencrypted: 1 });
    });

    it("dry-run never calls update but still counts pending re-encryptions", async () => {
        const { delegate, updateCalls } = fakeDelegate([
            { id: "default", lidarrApiKey: "plain-key" },
        ]);

        const stats = await migrateModelRows(
            "systemSettings",
            delegate,
            ["lidarrApiKey"],
            ENCRYPTED_MODEL_PRIMARY_KEYS.systemSettings,
            false
        );

        expect(updateCalls).toHaveLength(0);
        expect(stats).toMatchObject({ rows: 1, reencrypted: 1 });
    });

    it("skips v2 rows without updating and counts undecryptable values as skipped", async () => {
        const undecryptable = legacyEncrypt(
            "lost",
            "a-totally-different-32byte-key-000000"
        );
        const { delegate, updateCalls } = fakeDelegate([
            { id: "u1", subsonicPassword: "v2:aa:bb:cc:dd" },
            { id: "u2", subsonicPassword: undecryptable },
        ]);

        const stats = await migrateModelRows(
            "user",
            delegate,
            ["subsonicPassword"],
            ENCRYPTED_MODEL_PRIMARY_KEYS.user,
            true
        );

        expect(updateCalls).toHaveLength(0);
        expect(stats).toMatchObject({
            rows: 2,
            reencrypted: 0,
            alreadyV2: 1,
            skippedErrors: 1,
        });
    });
});
