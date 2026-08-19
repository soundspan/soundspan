jest.mock("../../config", () => ({
    config: { workers: { federationSyncIntervalMinutes: 60 } },
}));
const groupBy = jest.fn();
const findMany = jest.fn();
const zCount = jest.fn();
const logWarn = jest.fn();
const prisma = {
    federationPeer: { findMany, updateMany: jest.fn() },
    artist: { groupBy },
    album: { groupBy },
    track: { groupBy },
    audiobook: { groupBy },
    federationPodcastListing: { groupBy },
};
jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../utils/redis", () => ({ redisClient: { zCount } }));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: logWarn }) },
}));

import {
    collectFederationLeaseMetricSnapshot,
    collectFederationWorkerMetricSnapshot,
    deriveFederationHealthState,
    listFederationPeerHealth,
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
    beforeEach(() => {
        jest.clearAllMocks();
        groupBy.mockResolvedValue([]);
        zCount.mockResolvedValue(0);
    });

    it.each([
        ["green", input({ syncLagSeconds: 2 * HOUR_SECONDS - 1 })],
        ["amber", input({ syncLagSeconds: 2 * HOUR_SECONDS })],
        ["red", input({ syncLagSeconds: 6 * HOUR_SECONDS })],
        ["red", input({ outboundStatus: "OFFLINE" })],
        ["revoked", input({ outboundStatus: "REVOKED" })],
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
                syncLagSeconds: 100 * HOUR_SECONDS,
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

    it.each([
        [
            "authorization basic",
            "Authorization: Basic dXNlcjpwYXNzd29yZA==",
            "dXNlcjpwYXNzd29yZA==",
        ],
        [
            "apiKey",
            "apiKey=super-secret-api-key-value",
            "super-secret-api-key-value",
        ],
        [
            "access token",
            "access_token=access-token-secret-value",
            "access-token-secret-value",
        ],
        [
            "client secret",
            "client_secret=client-secret-value",
            "client-secret-value",
        ],
        [
            "x-api-key header",
            "x-api-key: header-secret-value",
            "header-secret-value",
        ],
        [
            "generic high-entropy value",
            "session=0123456789abcdef0123456789abcdef",
            "0123456789abcdef0123456789abcdef",
        ],
    ])("redacts %s credentials", (_label, credential, secret) => {
        const message = safeFederationErrorMessage(
            new Error(`request failed with ${credential}`),
        );

        expect(message).not.toContain(secret);
        expect(message).toContain("[redacted]");
    });

    it("warns when the worker metric peer query reaches its cap", async () => {
        findMany.mockResolvedValue(
            Array.from({ length: 500 }, (_, index) => ({
                id: `peer-${index}`,
                lastSyncSuccessAt: null,
            })),
        );

        await collectFederationWorkerMetricSnapshot();

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    direction: { in: ["CONSUMER", "BOTH"] },
                    outboundStatus: { not: "REVOKED" },
                },
            }),
        );
        expect(logWarn).toHaveBeenCalledWith(
            "Federation peer query reached its collection cap",
            { collector: "worker_metrics", maxPeers: 500 },
        );
    });

    it("caps concurrent Redis lease queries at the batch size", async () => {
        findMany.mockResolvedValue(
            Array.from({ length: 51 }, (_, index) => ({ id: `peer-${index}` })),
        );
        let active = 0;
        let maximum = 0;
        zCount.mockImplementation(async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise<void>((resolve) => setImmediate(resolve));
            active -= 1;
            return 1;
        });

        const snapshots = await collectFederationLeaseMetricSnapshot();

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    direction: { in: ["HOST", "BOTH"] },
                    inboundStatus: { not: "REVOKED" },
                },
            }),
        );
        expect(snapshots).toHaveLength(51);
        expect(zCount).toHaveBeenCalledTimes(51);
        expect(maximum).toBe(25);
    });

    it("keeps a revoked peer in admin health with a distinct state", async () => {
        findMany.mockResolvedValueOnce([
            {
                id: "peer-revoked",
                name: "Revoked Library",
                direction: "BOTH",
                inboundStatus: "REVOKED",
                outboundStatus: "REVOKED",
                lastSeenAt: null,
                lastSyncSuccessAt: null,
                lastSyncDurationMs: null,
                maxConcurrentStreams: 2,
                lastError: null,
                lastErrorAt: null,
            },
        ]);

        const peers = await listFederationPeerHealth();

        expect(peers).toHaveLength(1);
        expect(peers[0]).toEqual(
            expect.objectContaining({
                id: "peer-revoked",
                health: "revoked",
            }),
        );
    });
});
