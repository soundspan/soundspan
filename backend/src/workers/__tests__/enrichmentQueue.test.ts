import {
    enqueueReservedWork,
    type EnrichmentQueueRedis,
} from "../enrichmentQueue";

describe("enrichment queue admission", () => {
    it.each([
        [1, "queued"],
        [0, "duplicate"],
        [-1, "full"],
    ] as const)("maps Redis result %s to %s", async (redisResult, expected) => {
        const client: EnrichmentQueueRedis = {
            eval: jest.fn().mockResolvedValue(redisResult),
        };

        await expect(
            enqueueReservedWork(client, {
                queueKey: "audio:analysis:queue",
                trackId: "track-1",
                payload: "payload",
                maxDepth: 100,
                reservationTtlSeconds: 3600,
            }),
        ).resolves.toBe(expected);

        expect(client.eval).toHaveBeenCalledWith(
            expect.any(String),
            2,
            "audio:analysis:queue",
            "audio:analysis:queue:reserved:track-1",
            "100",
            "3600",
            "payload",
        );
    });

    it("rejects an unexpected Redis response", async () => {
        const client: EnrichmentQueueRedis = {
            eval: jest.fn().mockResolvedValue("unexpected"),
        };

        await expect(
            enqueueReservedWork(client, {
                queueKey: "audio:analysis:queue",
                trackId: "track-1",
                payload: "payload",
                maxDepth: 100,
                reservationTtlSeconds: 3600,
            }),
        ).rejects.toThrow("Unexpected enrichment queue admission result");
    });
});
