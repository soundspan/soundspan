import {
    cleanupLegacyVibeRedisArtifacts,
    type LegacyVibeRedisCleanupClient,
} from "../legacyVibeRedisCleanup";

function createClient(): jest.Mocked<LegacyVibeRedisCleanupClient> {
    return {
        del: jest.fn().mockResolvedValue(1),
        scan: jest.fn().mockResolvedValue({ cursor: "0", keys: [] }),
        set: jest.fn().mockResolvedValue("OK"),
        ttl: jest.fn().mockResolvedValue(60),
        xGroupDestroy: jest.fn().mockResolvedValue(1),
    };
}

describe("legacy vibe Redis cleanup", () => {
    const logger = { warn: jest.fn() };

    beforeEach(() => {
        logger.warn.mockClear();
    });

    it("removes the retired stream, consumer group, and heartbeat", async () => {
        const client = createClient();

        await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.set).toHaveBeenCalledWith(
            "soundspan:legacy-vibe-cleanup:v1",
            "done",
            { NX: true },
        );
        expect(client.xGroupDestroy).toHaveBeenCalledWith(
            "audio:text:embed:requests",
            "clap:text:embed:group",
        );
        expect(client.del).toHaveBeenCalledWith("audio:text:embed:requests");
        expect(client.del).toHaveBeenCalledWith("clap:worker:heartbeat");
    });

    it("scans bounded pages and deletes only reservations missing a TTL", async () => {
        const client = createClient();
        client.scan
            .mockResolvedValueOnce({
                cursor: "17",
                keys: [
                    "audio:clap:queue:reserved:stale",
                    "audio:clap:queue:reserved:active",
                ],
            })
            .mockResolvedValueOnce({ cursor: "0", keys: [] });
        client.ttl.mockResolvedValueOnce(-1).mockResolvedValueOnce(120);

        const result = await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.scan).toHaveBeenNthCalledWith(1, "0", {
            MATCH: "audio:clap:queue:reserved:*",
            COUNT: 2048,
        });
        expect(client.scan).toHaveBeenNthCalledWith(2, "17", {
            MATCH: "audio:clap:queue:reserved:*",
            COUNT: 2048,
        });
        expect(client.del).toHaveBeenCalledWith(
            "audio:clap:queue:reserved:stale",
        );
        expect(client.del).not.toHaveBeenCalledWith(
            "audio:clap:queue:reserved:active",
        );
        expect(result).toEqual({ staleReservationsDeleted: 1 });
    });

    it("processes every reservation returned in one bounded scan page", async () => {
        const client = createClient();
        const keys = Array.from(
            { length: 150 },
            (_, index) => `audio:clap:queue:reserved:legacy-${index}`,
        );
        client.scan.mockResolvedValueOnce({ cursor: "0", keys });
        client.ttl.mockResolvedValue(-1);

        const result = await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.ttl).toHaveBeenCalledTimes(150);
        expect(client.del).toHaveBeenCalledTimes(152);
        expect(result).toEqual({ staleReservationsDeleted: 150 });
    });

    it("stops before processing an oversized scan page", async () => {
        const client = createClient();
        const keys = Array.from(
            { length: 2049 },
            (_, index) => `audio:clap:queue:reserved:legacy-${index}`,
        );
        client.scan.mockResolvedValueOnce({ cursor: "17", keys });

        await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.scan).toHaveBeenCalledTimes(1);
        expect(client.ttl).not.toHaveBeenCalled();
        expect(client.del).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            "Legacy vibe reservation scan page exceeded its key limit",
            { cursor: "0", keyCount: 2049, maxKeysPerPage: 2048 },
        );
    });

    it("never deletes expiring or already-missing reservations", async () => {
        const client = createClient();
        client.scan.mockResolvedValueOnce({
            cursor: "0",
            keys: [
                "audio:clap:queue:reserved:legacy",
                "audio:clap:queue:reserved:current",
                "audio:clap:queue:reserved:missing",
            ],
        });
        client.ttl
            .mockResolvedValueOnce(-1)
            .mockResolvedValueOnce(3600)
            .mockResolvedValueOnce(-2);

        await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.del).toHaveBeenCalledWith(
            "audio:clap:queue:reserved:legacy",
        );
        expect(client.del).not.toHaveBeenCalledWith(
            "audio:clap:queue:reserved:current",
        );
        expect(client.del).not.toHaveBeenCalledWith(
            "audio:clap:queue:reserved:missing",
        );
    });

    it("skips cleanup when another replica owns the durable marker", async () => {
        const client = createClient();
        client.set.mockResolvedValueOnce(null);

        await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.xGroupDestroy).not.toHaveBeenCalled();
        expect(client.del).not.toHaveBeenCalled();
        expect(client.scan).not.toHaveBeenCalled();
    });

    it("does not scan when the durable marker claim fails", async () => {
        const client = createClient();
        client.set.mockRejectedValueOnce(new Error("redis unavailable"));

        await cleanupLegacyVibeRedisArtifacts(client, logger);

        expect(client.xGroupDestroy).not.toHaveBeenCalled();
        expect(client.scan).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to claim the legacy vibe Redis cleanup marker",
            { error: expect.any(Error) },
        );
    });

    it("continues cleaning independent artifacts after a missing group", async () => {
        const client = createClient();
        client.xGroupDestroy.mockRejectedValueOnce(new Error("NOGROUP"));

        await expect(
            cleanupLegacyVibeRedisArtifacts(client, logger),
        ).resolves.toEqual({ staleReservationsDeleted: 0 });

        expect(client.del).toHaveBeenCalledWith("audio:text:embed:requests");
        expect(client.del).toHaveBeenCalledWith("clap:worker:heartbeat");
        expect(client.scan).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            "Failed to remove the legacy text-embedding consumer group",
            { error: expect.any(Error) },
        );
    });
});
