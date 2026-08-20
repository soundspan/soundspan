jest.mock("../utils/db", () => ({
    prisma: { $connect: jest.fn() },
}));

jest.mock("../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

jest.mock("../config", () => ({
    config: {
        features: { federation: false },
        workers: { providerTrackRetentionDays: 30 },
    },
}));

import { withDataIntegrityPrismaRetry } from "../workers/dataIntegrity";
import { prisma } from "../utils/db";

const mockConnect = prisma.$connect as jest.Mock;

describe("data integrity Prisma retry", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        mockConnect.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("reconnects and retries a transient engine failure before succeeding", async () => {
        const operation = jest
            .fn<Promise<string>, []>()
            .mockRejectedValueOnce(
                new Error("Response from the Engine was empty"),
            )
            .mockResolvedValueOnce("complete");

        const result = withDataIntegrityPrismaRetry(
            "test.operation",
            operation,
        );
        await jest.runAllTimersAsync();

        await expect(result).resolves.toBe("complete");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(operation.mock.invocationCallOrder[0]).toBeLessThan(
            mockConnect.mock.invocationCallOrder[0],
        );
        expect(mockConnect.mock.invocationCallOrder[0]).toBeLessThan(
            operation.mock.invocationCallOrder[1],
        );
    });

    it("stops after three transient attempts", async () => {
        const error = new Error("Response from the Engine was empty");
        const operation = jest
            .fn<Promise<never>, []>()
            .mockRejectedValue(error);

        const result = withDataIntegrityPrismaRetry(
            "test.operation",
            operation,
        );
        const rejection = expect(result).rejects.toBe(error);
        await jest.runAllTimersAsync();

        await rejection;
        expect(operation).toHaveBeenCalledTimes(3);
        expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-transient failure", async () => {
        const error = new Error("validation failed");
        const operation = jest
            .fn<Promise<never>, []>()
            .mockRejectedValueOnce(error);

        await expect(
            withDataIntegrityPrismaRetry("test.operation", operation),
        ).rejects.toBe(error);
        expect(operation).toHaveBeenCalledTimes(1);
        expect(mockConnect).not.toHaveBeenCalled();
    });
});
