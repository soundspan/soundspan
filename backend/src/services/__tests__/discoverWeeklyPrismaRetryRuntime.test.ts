const prisma = {
    $connect: jest.fn(async () => undefined),
};

jest.mock("../../utils/db", () => ({ prisma }));

const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
logger.child.mockReturnValue(logger);

jest.mock("../../utils/logger", () => ({ logger }));

import { createPrismaRetryProxy } from "../discoverWeekly/state";

describe("discover weekly prisma retry behavior", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("reconnects and retries a nested Prisma operation after a transient failure", async () => {
        const findMany = jest
            .fn<Promise<string[]>, []>()
            .mockRejectedValueOnce(new Error("Connection reset"))
            .mockResolvedValueOnce(["track-1"]);
        const client = { track: { findMany } };
        const retryingClient = createPrismaRetryProxy(client, "discoverWeekly");

        const resultPromise = retryingClient.track.findMany();
        await jest.advanceTimersByTimeAsync(250);

        await expect(resultPromise).resolves.toEqual(["track-1"]);
        expect(findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("stops after three transient failures", async () => {
        const transientError = new Error("Can't reach database server");
        const findMany = jest
            .fn<Promise<never>, []>()
            .mockRejectedValue(transientError);
        const client = { track: { findMany } };
        const retryingClient = createPrismaRetryProxy(client, "discoverWeekly");

        const resultPromise = retryingClient.track.findMany();
        const rejection = expect(resultPromise).rejects.toBe(transientError);
        await jest.advanceTimersByTimeAsync(750);

        await rejection;
        expect(findMany).toHaveBeenCalledTimes(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-transient failures", async () => {
        const fatalError = new Error("Invalid query");
        const findMany = jest
            .fn<Promise<never>, []>()
            .mockRejectedValue(fatalError);
        const client = { track: { findMany } };
        const retryingClient = createPrismaRetryProxy(client, "discoverWeekly");

        await expect(retryingClient.track.findMany()).rejects.toBe(fatalError);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(prisma.$connect).not.toHaveBeenCalled();
    });
});
