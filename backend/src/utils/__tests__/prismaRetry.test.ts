const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockWarn = jest.fn();

jest.mock("../db", () => ({
    prisma: {
        $connect: mockConnect,
        $disconnect: mockDisconnect,
    },
}));

jest.mock("@prisma/client", () => ({
    Prisma: {
        PrismaClientKnownRequestError: class extends Error {
            constructor(
                message: string,
                readonly code: string,
            ) {
                super(message);
            }
        },
        PrismaClientRustPanicError: class extends Error {},
        PrismaClientUnknownRequestError: class extends Error {},
    },
}));

jest.mock("../logger", () => ({
    logger: { child: () => ({ warn: mockWarn }) },
}));

import { Prisma } from "@prisma/client";
import { withPrismaRetry } from "../prismaRetry";

describe("withPrismaRetry", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConnect.mockResolvedValue(undefined);
        mockDisconnect.mockResolvedValue(undefined);
    });

    it("retries transient failures with the configured bounded delay", async () => {
        jest.useFakeTimers();
        const operation = jest
            .fn()
            .mockRejectedValueOnce(new Error("Connection reset"))
            .mockResolvedValueOnce("ok");

        const result = withPrismaRetry("test.read", operation, {
            baseDelayMs: 5,
        });
        await jest.advanceTimersByTimeAsync(5);

        await expect(result).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(mockConnect).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    it("preserves P2037 disconnect and longer backoff semantics", async () => {
        jest.useFakeTimers();
        const operation = jest
            .fn()
            .mockRejectedValueOnce(
                new (Prisma.PrismaClientKnownRequestError as any)(
                    "busy",
                    "P2037",
                ),
            )
            .mockResolvedValueOnce("ok");

        const result = withPrismaRetry("test.enrichment", operation, {
            baseDelayMs: 5,
            disconnectOnP2037: true,
            p2037DelayMs: 20,
        });
        await jest.advanceTimersByTimeAsync(20);

        await expect(result).resolves.toBe("ok");
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        expect(mockConnect).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    it("does not retry permanent failures", async () => {
        const error = new Error("invalid query");
        await expect(
            withPrismaRetry("test.write", async () => Promise.reject(error)),
        ).rejects.toBe(error);
        expect(mockConnect).not.toHaveBeenCalled();
    });
});
