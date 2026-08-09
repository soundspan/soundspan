import { isOriginAllowed } from "../cors";

describe("isOriginAllowed", () => {
    it("allows requests with no origin (same-origin, curl, server-to-server)", () => {
        expect(isOriginAllowed(undefined, [], "production")).toBe(true);
        expect(isOriginAllowed("", ["https://app.example"], "production")).toBe(
            true
        );
    });

    it("denies cross-origin requests when no allowlist is configured (deny-by-default)", () => {
        // Production posture: an unconfigured allowlist must NOT reflect
        // arbitrary origins while credentials are enabled. Operators opt back
        // into the legacy permissive behavior with CORS_ALLOW_ALL=true, which
        // config.ts resolves to `allowedOrigins: true`.
        expect(isOriginAllowed("https://anything.example", [], "production")).toBe(
            false
        );
        expect(isOriginAllowed("https://anything.example", [], "test")).toBe(
            false
        );
    });

    it("allows all origins when explicitly set to true or in development", () => {
        // `true` is the resolved CORS_ALLOW_ALL / legacy opt-out value.
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
