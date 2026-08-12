// The hash pepper resolves from API_KEY_PEPPER → SETTINGS_ENCRYPTION_KEY →
// SESSION_SECRET; set one before importing the module under test.
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY || "api-key-hash-test-pepper-123456789";

import {
    hashApiKey,
    isHashedApiKey,
    findApiKeyRecord,
    planApiKeyHashing,
    getPepperSource,
    getPepperFingerprint,
    getApiKeyExpiresAt,
    isApiKeyExpired,
    API_KEY_LIFETIME_MS,
    HASHED_KEY_PREFIX,
} from "../apiKeyHash";

describe("apiKeyHash", () => {
    it("hashes deterministically into a prefixed HMAC-hex value", () => {
        const raw = "a".repeat(64);
        const hashed = hashApiKey(raw);

        expect(hashed).toBe(hashApiKey(raw)); // deterministic
        expect(hashed.startsWith(HASHED_KEY_PREFIX)).toBe(true);
        // 'hmac:' + 64 hex chars
        expect(hashed).toMatch(/^hmac:[0-9a-f]{64}$/);
        // The raw key never appears in the stored value.
        expect(hashed).not.toContain(raw);
    });

    it("produces different hashes for different keys", () => {
        expect(hashApiKey("key-one")).not.toBe(hashApiKey("key-two"));
    });

    it("assigns and enforces a bounded API-key lifetime", () => {
        const createdAt = new Date("2026-01-01T00:00:00.000Z");
        const expiresAt = getApiKeyExpiresAt(createdAt);

        expect(expiresAt.getTime() - createdAt.getTime()).toBe(
            API_KEY_LIFETIME_MS,
        );
        expect(
            isApiKeyExpired(createdAt, new Date(expiresAt.getTime() - 1)),
        ).toBe(false);
        expect(isApiKeyExpired(createdAt, expiresAt)).toBe(true);
        expect(isApiKeyExpired("invalid-date", createdAt)).toBe(true);
    });

    it("isHashedApiKey distinguishes migrated values from legacy plaintext keys", () => {
        expect(isHashedApiKey(hashApiKey("x"))).toBe(true);
        // A legacy plaintext key (64 random hex chars) has no prefix.
        expect(isHashedApiKey("deadbeef".repeat(8))).toBe(false);
        expect(isHashedApiKey(null)).toBe(false);
        expect(isHashedApiKey(undefined)).toBe(false);
        expect(isHashedApiKey("")).toBe(false);
    });

    describe("findApiKeyRecord (dual-validate grace window)", () => {
        it("looks up the hashed form first and returns it when present", async () => {
            const raw = "raw-key-abc";
            const hashed = hashApiKey(raw);
            const lookup = jest.fn(async (key: string) =>
                key === hashed ? { id: "hashed-row" } : null,
            );

            const record = await findApiKeyRecord(raw, lookup);

            expect(record).toEqual({ id: "hashed-row" });
            expect(lookup).toHaveBeenCalledWith(hashed);
            // No need to fall back to the raw lookup once the hash hits.
            expect(lookup).toHaveBeenCalledTimes(1);
        });

        it("falls back to the raw key for not-yet-migrated (plaintext) rows", async () => {
            const raw = "raw-key-def";
            const hashed = hashApiKey(raw);
            const lookup = jest.fn(async (key: string) =>
                key === raw ? { id: "legacy-row" } : null,
            );

            const record = await findApiKeyRecord(raw, lookup);

            expect(record).toEqual({ id: "legacy-row" });
            expect(lookup).toHaveBeenNthCalledWith(1, hashed); // hash first
            expect(lookup).toHaveBeenNthCalledWith(2, raw); // then raw fallback
        });

        it("returns null when neither form matches", async () => {
            const lookup = jest.fn(async () => null);
            expect(await findApiKeyRecord("nope", lookup)).toBeNull();
            expect(lookup).toHaveBeenCalledTimes(2);
        });

        it("refuses to authenticate a leaked stored hash presented as the raw key", async () => {
            // An attacker with a DB dump knows the stored value `hmac:<h>` and
            // presents it as the X-API-Key. The raw fallback must NOT match it,
            // or at-rest hashing would be pointless.
            const stored = hashApiKey("real-raw-key"); // hmac:<h>
            const lookup = jest.fn(async (key: string) =>
                key === stored ? { id: "victim-row" } : null,
            );

            const record = await findApiKeyRecord(stored, lookup);

            expect(record).toBeNull();
            // The hashed-form lookup is attempted (hash of the presented value),
            // but the verbatim fallback to `stored` is skipped.
            expect(lookup).not.toHaveBeenCalledWith(stored);
        });
    });

    it("getPepperSource reports the highest-precedence configured env var", () => {
        const original = process.env.API_KEY_PEPPER;
        try {
            process.env.API_KEY_PEPPER = "dedicated-pepper";
            expect(getPepperSource()).toBe("API_KEY_PEPPER");
            delete process.env.API_KEY_PEPPER;
            // SETTINGS_ENCRYPTION_KEY is set at the top of this file.
            expect(getPepperSource()).toBe("SETTINGS_ENCRYPTION_KEY");
        } finally {
            if (original === undefined) delete process.env.API_KEY_PEPPER;
            else process.env.API_KEY_PEPPER = original;
        }
    });

    it("falls back to the ENCRYPTION_KEY compat alias before SESSION_SECRET", () => {
        // encryption.ts honors ENCRYPTION_KEY as a documented alias of
        // SETTINGS_ENCRYPTION_KEY. An install configured that way must not
        // silently pepper API keys with SESSION_SECRET — docker-entrypoint.sh
        // REGENERATES an unset SESSION_SECRET on every restart, which would
        // invalidate all keys hashed since the last restart.
        const saved = {
            settings: process.env.SETTINGS_ENCRYPTION_KEY,
            compat: process.env.ENCRYPTION_KEY,
            session: process.env.SESSION_SECRET,
        };
        try {
            delete process.env.SETTINGS_ENCRYPTION_KEY;
            process.env.ENCRYPTION_KEY = "compat-alias-pepper-1234567890";
            process.env.SESSION_SECRET = "ephemeral-session-secret-000000000";

            expect(getPepperSource()).toBe("ENCRYPTION_KEY");
            const hashed = hashApiKey("raw-key");
            delete process.env.SESSION_SECRET;
            // Still resolvable (and identical) without SESSION_SECRET present.
            expect(hashApiKey("raw-key")).toBe(hashed);
        } finally {
            if (saved.settings !== undefined)
                process.env.SETTINGS_ENCRYPTION_KEY = saved.settings;
            if (saved.compat === undefined) delete process.env.ENCRYPTION_KEY;
            else process.env.ENCRYPTION_KEY = saved.compat;
            if (saved.session === undefined) delete process.env.SESSION_SECRET;
            else process.env.SESSION_SECRET = saved.session;
        }
    });

    it("getPepperFingerprint identifies the pepper value, not just its source name", () => {
        const original = process.env.API_KEY_PEPPER;
        try {
            process.env.API_KEY_PEPPER = "pepper-value-one";
            const fp1 = getPepperFingerprint();
            expect(fp1).toMatch(/^[0-9a-f]{8}$/);
            expect(getPepperFingerprint()).toBe(fp1); // deterministic
            // A DIFFERENT value under the SAME source name yields a different
            // fingerprint — this is what catches a script-env vs app-env
            // mismatch before --apply writes anything.
            process.env.API_KEY_PEPPER = "pepper-value-two";
            expect(getPepperFingerprint()).not.toBe(fp1);
            // The fingerprint never leaks the pepper itself.
            expect(fp1).not.toContain("pepper-value-one");
        } finally {
            if (original === undefined) delete process.env.API_KEY_PEPPER;
            else process.env.API_KEY_PEPPER = original;
        }
    });

    describe("planApiKeyHashing (backfill decision)", () => {
        it("skips rows already hashed (idempotent re-runs)", () => {
            const hashed = hashApiKey("some-raw-key");
            expect(planApiKeyHashing(hashed)).toEqual({
                action: "skip-hashed",
            });
        });

        it("hashes a legacy plaintext key into its at-rest form", () => {
            const plaintext = "deadbeef".repeat(8); // 64 hex, no prefix
            const outcome = planApiKeyHashing(plaintext);
            expect(outcome).toEqual({
                action: "hash",
                value: hashApiKey(plaintext),
            });
            // The migrated value still validates the original raw key.
            if (outcome.action !== "hash") throw new Error("unreachable");
            expect(outcome.value).toBe(hashApiKey(plaintext));
        });
    });
});
