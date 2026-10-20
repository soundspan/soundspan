import { encryptWithKey } from "../../../utils/encryption";
import type { Client } from "pg";
import {
    planCredentialReencryption,
    reencryptRestoredCredentials,
} from "../restoreReencrypt";

const backupKey = "a".repeat(40);
const currentKey = "b".repeat(40);

describe("credential re-encryption planning", () => {
    it("re-encrypts a backup-key value", () => {
        expect(
            planCredentialReencryption(
                encryptWithKey("secret", backupKey),
                backupKey,
                currentKey,
            ).action,
        ).toBe("reencrypt");
    });

    it("skips a value already encrypted by the current key", () => {
        expect(
            planCredentialReencryption(
                encryptWithKey("secret", currentKey),
                backupKey,
                currentKey,
            ),
        ).toEqual({ action: "skip-current" });
    });

    it("counts a value decryptable by neither key", () => {
        expect(
            planCredentialReencryption(
                "v2:broken:value",
                backupKey,
                currentKey,
            ),
        ).toEqual({ action: "undecryptable" });
    });

    it("short-circuits when keys match", () => {
        expect(
            planCredentialReencryption("anything", backupKey, backupKey),
        ).toEqual({ action: "skip-current" });
    });

    it("skips empty and non-string values", () => {
        expect(planCredentialReencryption(null, backupKey, currentKey)).toEqual(
            { action: "skip-empty" },
        );
        expect(planCredentialReencryption("", backupKey, currentKey)).toEqual({
            action: "skip-empty",
        });
    });

    it("updates registered available columns and reports unreadable values", async () => {
        const backupEncrypted = encryptWithKey("backup-secret", backupKey);
        const currentEncrypted = encryptWithKey("current-secret", currentKey);
        const queries: Array<{ sql: string; params?: unknown[] }> = [];
        const client = {
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                queries.push({ sql, params });
                if (sql.includes("information_schema.columns")) {
                    return {
                        rows: [
                            { table_name: "SystemSettings", column_name: "id" },
                            {
                                table_name: "SystemSettings",
                                column_name: "lastfmApiKey",
                            },
                            {
                                table_name: "SystemSettings",
                                column_name: "spotifyClientSecret",
                            },
                            { table_name: "User", column_name: "id" },
                            {
                                table_name: "User",
                                column_name: "twoFactorSecret",
                            },
                        ],
                    };
                }
                if (sql.includes('FROM public."SystemSettings"')) {
                    return {
                        rows: [
                            {
                                id: "settings",
                                lastfmApiKey: backupEncrypted,
                                spotifyClientSecret: "v2:broken:value",
                            },
                        ],
                    };
                }
                if (sql.includes('FROM public."User"')) {
                    return {
                        rows: [
                            { id: "user-1", twoFactorSecret: currentEncrypted },
                        ],
                    };
                }
                return { rows: [], rowCount: 1 };
            }),
        } as unknown as Client;

        const result = await reencryptRestoredCredentials(
            client,
            backupKey,
            currentKey,
            new Set(["SystemSettings.spotifyClientSecret"]),
        );

        expect(result).toEqual({
            credentialsReencrypted: 1,
            credentialsUndecryptable: 0,
            processedColumns: expect.arrayContaining([
                "SystemSettings.lastfmApiKey",
                "User.twoFactorSecret",
            ]),
        });
        const update = queries.find((entry) =>
            entry.sql.includes('UPDATE public."SystemSettings"'),
        );
        expect(update?.params?.[1]).toBe("settings");
        expect(update?.params?.[0]).not.toBe(backupEncrypted);
        expect(
            queries.some((entry) => entry.sql.includes('UPDATE public."User"')),
        ).toBe(false);
    });

    it("returns without catalog access when the keys match", async () => {
        const client = { query: jest.fn() } as unknown as Client;
        await expect(
            reencryptRestoredCredentials(client, backupKey, backupKey),
        ).resolves.toEqual({
            credentialsReencrypted: 0,
            credentialsUndecryptable: 0,
            processedColumns: [],
        });
        expect(client.query).not.toHaveBeenCalled();
    });
});
