import {
    APP_PASSWORD_SECRET_PREFIX,
    generateAppPasswordSecret,
} from "../appPasswords";

describe("app password secrets", () => {
    it("generates a prefixed 24-byte base64url secret", () => {
        const secret = generateAppPasswordSecret();
        const encoded = secret.slice(APP_PASSWORD_SECRET_PREFIX.length);

        expect(secret).toMatch(/^ssap_[A-Za-z0-9_-]{32}$/);
        expect(Buffer.from(encoded, "base64url")).toHaveLength(24);
    });

    it("generates distinct secrets", () => {
        expect(generateAppPasswordSecret()).not.toBe(
            generateAppPasswordSecret(),
        );
    });
});
