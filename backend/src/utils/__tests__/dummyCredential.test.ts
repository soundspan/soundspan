import { runDummyBcrypt, DUMMY_PASSWORD_HASH } from "../dummyCredential";

describe("dummyCredential", () => {
    it("DUMMY_PASSWORD_HASH is a valid bcrypt hash", () => {
        // bcrypt hashes start with $2a$, $2b$, or $2y$ and are 60 chars
        expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/);
    });

    it("runDummyBcrypt completes without throwing", async () => {
        await expect(runDummyBcrypt()).resolves.toBeUndefined();
    });

    it("DUMMY_PASSWORD_HASH never matches a real user password", async () => {
        const bcrypt = await import("bcrypt");
        // Verify typical user passwords do not match the dummy hash
        const result = await bcrypt.compare("password123", DUMMY_PASSWORD_HASH);
        expect(result).toBe(false);
    });
});
