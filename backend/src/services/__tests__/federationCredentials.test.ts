process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "federation-credential-test-key-123456";

import {
    backfillFederationOutboundTokens,
    type FederationCredentialBackfillStore,
} from "../federationCredentials";
import {
    decryptFederationOutboundToken,
    encryptFederationOutboundToken,
} from "../federationCredentialCipher";

describe("federation outbound credential encryption", () => {
    it("round-trips a token through the persistence writer and client reader", () => {
        const stored = encryptFederationOutboundToken("raw-peer-token");

        expect(stored).toMatch(/^v2:/);
        expect(stored).not.toContain("raw-peer-token");
        expect(decryptFederationOutboundToken(stored)).toBe("raw-peer-token");
    });

    it("backfills plaintext once and is a no-op on the second run", async () => {
        const rows = [
            { id: "peer-1", outboundToken: "legacy-plaintext-token" },
            {
                id: "peer-2",
                outboundToken: encryptFederationOutboundToken("already-safe"),
            },
        ];
        const replaceIfUnchanged = jest.fn(
            async (id: string, previous: string, replacement: string) => {
                const row = rows.find((candidate) => candidate.id === id);
                if (!row || row.outboundToken !== previous) return false;
                row.outboundToken = replacement;
                return true;
            },
        );
        const store: FederationCredentialBackfillStore = {
            loadCandidates: jest.fn(async () => rows),
            replaceIfUnchanged,
        };
        const report = jest.fn();

        await expect(
            backfillFederationOutboundTokens(store, report),
        ).resolves.toBe(1);
        expect(rows[0].outboundToken).toMatch(/^v2:/);
        expect(decryptFederationOutboundToken(rows[0].outboundToken)).toBe(
            "legacy-plaintext-token",
        );

        await expect(
            backfillFederationOutboundTokens(store, report),
        ).resolves.toBe(0);
        expect(replaceIfUnchanged).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenNthCalledWith(1, 1);
        expect(report).toHaveBeenNthCalledWith(2, 0);
    });

    it("reads legacy plaintext only for the startup backfill window", () => {
        expect(decryptFederationOutboundToken("legacy-plaintext-token")).toBe(
            "legacy-plaintext-token",
        );
    });
});
