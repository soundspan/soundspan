import {
    cleanupLegacyVibeRedisArtifacts,
    type LegacyVibeRedisCleanupClient,
} from "../legacyVibeRedisCleanup";

function createClient(): jest.Mocked<LegacyVibeRedisCleanupClient> {
    return {
        del: jest.fn().mockResolvedValue(1),
        scan: jest.fn().mockResolvedValue({ cursor: "0", keys: [] }),
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
            COUNT: 100,
        });
        expect(client.scan).toHaveBeenNthCalledWith(2, "17", {
            MATCH: "audio:clap:queue:reserved:*",
            COUNT: 100,
        });
        expect(client.del).toHaveBeenCalledWith(
            "audio:clap:queue:reserved:stale",
        );
        expect(client.del).not.toHaveBeenCalledWith(
            "audio:clap:queue:reserved:active",
        );
        expect(result).toEqual({ staleReservationsDeleted: 1 });
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
