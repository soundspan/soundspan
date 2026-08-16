const prisma = {
    $connect: jest.fn(async () => undefined),
    spotifyImportJob: {
        findUnique: jest.fn(async () => null),
    },
};

const replacementRedis = {
    connect: jest.fn(async () => undefined),
    get: jest.fn(async () => null),
    setEx: jest.fn(async () => "OK"),
};
const redisClient = {
    duplicate: jest.fn(() => replacementRedis),
    get: jest.fn(async () => null),
    setEx: jest.fn(async () => "OK"),
};

class KnownRequestError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

class RustPanicError extends Error {}
class UnknownRequestError extends Error {}

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../../utils/redis", () => ({ redisClient }));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));
jest.mock("../../utils/playlistLogger", () => ({
    createPlaylistLogger: jest.fn(),
}));
jest.mock("@prisma/client", () => ({
    Prisma: {
        PrismaClientKnownRequestError: KnownRequestError,
        PrismaClientRustPanicError: RustPanicError,
        PrismaClientUnknownRequestError: UnknownRequestError,
    },
}));

import {
    createPrismaRetryProxy,
    getImportJob,
    isRetryableSpotifyImportPrismaError,
    isRetryableSpotifyImportRedisError,
} from "../spotifyImport/state";

describe("spotify import resilience", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.spotifyImportJob.findUnique.mockResolvedValue(null);
        redisClient.get.mockResolvedValue(null);
        replacementRedis.get.mockResolvedValue(null);
    });

    it("classifies retryable Prisma and Redis failures", () => {
        expect(
            isRetryableSpotifyImportPrismaError(new KnownRequestError("P1001")),
        ).toBe(true);
        expect(
            isRetryableSpotifyImportPrismaError(new KnownRequestError("P2002")),
        ).toBe(false);
        expect(
            isRetryableSpotifyImportRedisError(
                new Error("Connection is closed"),
            ),
        ).toBe(true);
        expect(isRetryableSpotifyImportRedisError(new Error("WRONGTYPE"))).toBe(
            false,
        );
    });

    it("retries a proxied Prisma operation after reconnecting", async () => {
        jest.useFakeTimers();
        const findFirst = jest
            .fn()
            .mockRejectedValueOnce(new Error("Connection reset"))
            .mockResolvedValueOnce({ id: "track-1" });
        const retryingClient = createPrismaRetryProxy(
            { track: { findFirst } },
            "test",
        );

        const resultPromise = retryingClient.track.findFirst();
        await jest.advanceTimersByTimeAsync(250);

        await expect(resultPromise).resolves.toEqual({ id: "track-1" });
        expect(findFirst).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    it("recreates a closed Redis client and retries the job lookup", async () => {
        redisClient.get.mockRejectedValueOnce(
            new Error("Connection is closed"),
        );

        await expect(getImportJob("import-1")).resolves.toBeNull();

        expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
        expect(replacementRedis.connect).toHaveBeenCalledTimes(1);
        expect(replacementRedis.get).toHaveBeenCalledWith(
            "import:job:import-1",
        );
        expect(prisma.spotifyImportJob.findUnique).toHaveBeenCalledWith({
            where: { id: "import-1" },
        });
    });
});
