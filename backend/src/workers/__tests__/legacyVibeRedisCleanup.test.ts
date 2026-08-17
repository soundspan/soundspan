import {
    cleanupLegacyVibeRedisArtifacts,
    type LegacyVibeRedisCleanupClient,
} from "../legacyVibeRedisCleanup";

function createClient(): jest.Mocked<LegacyVibeRedisCleanupClient> {
    return {
        del: jest.fn().mockResolvedValue(1),
        destroy: jest.fn(),
        eval: jest.fn().mockResolvedValue(1),
        get: jest.fn().mockResolvedValue(null),
        scan: jest.fn().mockResolvedValue({ cursor: "0", keys: [] }),
        set: jest.fn().mockResolvedValue("OK"),
        xGroupDestroy: jest.fn().mockResolvedValue(1),
    };
}

describe("legacy vibe Redis cleanup", () => {
    const logger = { warn: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    afterEach(() => jest.useRealTimers());

    it("uses an expiring owner lease and writes completion only after success", async () => {
        const client = createClient();

        await cleanupLegacyVibeRedisArtifacts(client, logger, {
            ownerToken: "owner-1",
        });

        expect(client.set).toHaveBeenCalledWith(
            "soundspan:legacy-vibe-cleanup:v1:lease",
            "owner-1",
            { NX: true, PX: 120_000 },
        );
        expect(client.eval).toHaveBeenLastCalledWith(
            expect.stringContaining("redis.call('SET', KEYS[2], 'done')"),
            {
                keys: [
                    "soundspan:legacy-vibe-cleanup:v1:lease",
                    "soundspan:legacy-vibe-cleanup:v1",
                ],
                arguments: ["owner-1"],
            },
        );
    });

    it("retries after an earlier owner's lease expires", async () => {
        const first = createClient();
        first.set.mockResolvedValueOnce(null);
        await expect(
            cleanupLegacyVibeRedisArtifacts(first, logger),
        ).resolves.toEqual({ staleReservationsDeleted: 0 });

        const later = createClient();
        await expect(
            cleanupLegacyVibeRedisArtifacts(later, logger),
        ).resolves.toEqual({ staleReservationsDeleted: 0 });

        expect(first.xGroupDestroy).not.toHaveBeenCalled();
        expect(later.xGroupDestroy).toHaveBeenCalledTimes(1);
    });

    it("does not write completion after an operation fails", async () => {
        const client = createClient();
        client.del.mockRejectedValueOnce(new Error("redis unavailable"));

        await expect(
            cleanupLegacyVibeRedisArtifacts(client, logger),
        ).rejects.toThrow("redis unavailable");

        expect(client.eval).not.toHaveBeenCalledWith(
            expect.stringContaining("redis.call('SET', KEYS[2], 'done')"),
            expect.anything(),
        );
    });

    it("treats an already-absent consumer group as cleaned", async () => {
        const client = createClient();
        client.xGroupDestroy.mockRejectedValueOnce(
            new Error("NOGROUP missing"),
        );

        await expect(
            cleanupLegacyVibeRedisArtifacts(client, logger, {
                ownerToken: "owner-absent-group",
            }),
        ).resolves.toEqual({ staleReservationsDeleted: 0 });

        expect(client.eval).toHaveBeenLastCalledWith(
            expect.stringContaining("redis.call('SET', KEYS[2], 'done')"),
            expect.objectContaining({ arguments: ["owner-absent-group"] }),
        );
    });

    it("checks TTL and deletes each legacy reservation atomically", async () => {
        const client = createClient();
        client.scan.mockResolvedValueOnce({
            cursor: "0",
            keys: ["audio:clap:queue:reserved:legacy"],
        });
        client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

        await expect(
            cleanupLegacyVibeRedisArtifacts(client, logger),
        ).resolves.toEqual({ staleReservationsDeleted: 1 });

        expect(client.eval).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("redis.call('TTL', KEYS[1]) == -1"),
            { keys: ["audio:clap:queue:reserved:legacy"] },
        );
        expect(client.del).not.toHaveBeenCalledWith(
            "audio:clap:queue:reserved:legacy",
        );
    });

    it("destroys the cleanup connection when one Redis operation exceeds its bound", async () => {
        jest.useFakeTimers();
        const client = createClient();
        client.get.mockImplementationOnce(() => new Promise(() => undefined));

        const cleanup = cleanupLegacyVibeRedisArtifacts(client, logger, {
            operationTimeoutMs: 25,
        });
        const rejection = expect(cleanup).rejects.toThrow(
            "Redis operation timed out",
        );
        await jest.advanceTimersByTimeAsync(25);

        await rejection;
        expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it("stops before processing an oversized scan page", async () => {
        const client = createClient();
        const keys = Array.from(
            { length: 2_049 },
            (_, index) => `audio:clap:queue:reserved:legacy-${index}`,
        );
        client.scan.mockResolvedValueOnce({ cursor: "17", keys });

        await expect(
            cleanupLegacyVibeRedisArtifacts(client, logger),
        ).rejects.toThrow("exceeded its key limit");
        expect(logger.warn).toHaveBeenCalledWith(
            "Legacy vibe reservation scan page exceeded its key limit",
            { cursor: "0", keyCount: 2_049, maxKeysPerPage: 2_048 },
        );
    });

    it("skips completed cleanup without acquiring a lease", async () => {
        const client = createClient();
        client.get.mockResolvedValueOnce("done");

        await expect(
            cleanupLegacyVibeRedisArtifacts(client, logger),
        ).resolves.toEqual({ staleReservationsDeleted: 0 });

        expect(client.set).not.toHaveBeenCalled();
        expect(client.scan).not.toHaveBeenCalled();
    });
});
