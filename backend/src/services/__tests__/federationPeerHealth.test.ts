jest.mock("../../config", () => ({
    config: { workers: { federationSyncIntervalMinutes: 60 } },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/redis", () => ({ redisClient: {} }));

import {
    deriveFederationHealthState,
    safeFederationErrorMessage,
} from "../federationPeerHealth";

const HOUR_MS = 60 * 60 * 1_000;
const HOUR_SECONDS = 60 * 60;
const now = new Date("2026-08-19T12:00:00.000Z");

function input(overrides: Record<string, unknown> = {}) {
    return {
        direction: "CONSUMER" as const,
        inboundStatus: null,
        outboundStatus: "ACTIVE" as const,
        syncLagSeconds: 60,
        lastErrorAt: null,
        ...overrides,
    };
}

describe("federation peer health", () => {
    it.each([
        ["green", input({ syncLagSeconds: 2 * HOUR_SECONDS - 1 })],
        ["amber", input({ syncLagSeconds: 2 * HOUR_SECONDS })],
        ["red", input({ syncLagSeconds: 6 * HOUR_SECONDS })],
        ["red", input({ outboundStatus: "OFFLINE" })],
        ["red", input({ syncLagSeconds: null })],
        [
            "amber",
            input({ lastErrorAt: new Date(now.getTime() - 24 * HOUR_MS + 1) }),
        ],
        [
            "green",
            input({ lastErrorAt: new Date(now.getTime() - 24 * HOUR_MS) }),
        ],
        [
            "green",
            input({
                direction: "HOST",
                inboundStatus: "ACTIVE",
                outboundStatus: null,
                syncLagSeconds: null,
            }),
        ],
    ])("derives %s at threshold boundaries", (expected, healthInput) => {
        expect(deriveFederationHealthState(healthInput, 60, now)).toBe(
            expected,
        );
    });

    it("redacts credential-bearing URLs and tokens before persistence", () => {
        const message = safeFederationErrorMessage(
            new Error(
                `failed https://user:password@peer.example/path?token=secret Bearer ${"a".repeat(64)}`,
            ),
        );

        expect(message).not.toContain("password");
        expect(message).not.toContain("secret");
        expect(message).not.toContain("a".repeat(64));
        expect(message.length).toBeLessThanOrEqual(500);
    });
});
