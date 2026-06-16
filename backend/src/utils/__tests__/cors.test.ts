import { isOriginAllowed } from "../cors";

describe("isOriginAllowed", () => {
    it("allows requests with no origin (same-origin, curl, server-to-server)", () => {
        expect(isOriginAllowed(undefined, [], "production")).toBe(true);
        expect(isOriginAllowed("", ["https://app.example"], "production")).toBe(
            true
        );
    });

    it("allows all origins when no allowlist is configured (self-hosted default)", () => {
        expect(isOriginAllowed("https://anything.example", [], "production")).toBe(
            true
        );
    });

    it("allows all origins when explicitly set to true or in development", () => {
        expect(isOriginAllowed("https://anything.example", true, "production")).toBe(
            true
        );
        expect(isOriginAllowed("https://anything.example", [], "development")).toBe(
            true
        );
    });

    it("enforces a configured allowlist: allows listed origins", () => {
        expect(
            isOriginAllowed(
                "https://app.example",
                ["https://app.example", "https://admin.example"],
                "production"
            )
        ).toBe(true);
    });

    it("enforces a configured allowlist: denies unlisted origins", () => {
        expect(
            isOriginAllowed(
                "https://evil.example",
                ["https://app.example"],
                "production"
            )
        ).toBe(false);
    });
});
