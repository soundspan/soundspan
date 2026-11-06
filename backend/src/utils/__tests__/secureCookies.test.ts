import {
    parseSecureCookieSetting,
    secureCookiePrefixedName,
    shouldUseSecureCookie,
} from "../secureCookies";

describe("parseSecureCookieSetting", () => {
    it.each([undefined, "", "   ", "auto", " AUTO "])(
        "treats %p as auto",
        (raw) => {
            expect(parseSecureCookieSetting(raw)).toBe("auto");
        },
    );

    it.each([
        ["true", true],
        [" TRUE ", true],
        ["false", false],
        ["False", false],
    ])("honors the explicit value %p", (raw, expected) => {
        expect(parseSecureCookieSetting(raw)).toBe(expected);
    });

    it("falls back to auto for an unrecognized value", () => {
        expect(parseSecureCookieSetting("yes-please")).toBe("auto");
    });
});

describe("shouldUseSecureCookie", () => {
    it("follows the request scheme in auto mode", () => {
        expect(shouldUseSecureCookie("auto", { secure: true })).toBe(true);
        expect(shouldUseSecureCookie("auto", { secure: false })).toBe(false);
    });

    it("lets an explicit setting override the request scheme", () => {
        expect(shouldUseSecureCookie(true, { secure: false })).toBe(true);
        expect(shouldUseSecureCookie(false, { secure: true })).toBe(false);
    });
});

describe("secureCookiePrefixedName", () => {
    it("adds the prefix only for secure cookies", () => {
        expect(secureCookiePrefixedName("name", "__Secure-", true)).toBe(
            "__Secure-name",
        );
        expect(secureCookiePrefixedName("name", "__Host-", true)).toBe(
            "__Host-name",
        );
        expect(secureCookiePrefixedName("name", "__Host-", false)).toBe("name");
    });
});
