import { jest } from "@jest/globals";

type RedisClient = {
    on: jest.MockedFunction<
        (event: string, handler: (...args: unknown[]) => void) => RedisClient
    >;
    connect: jest.MockedFunction<() => Promise<void>>;
    duplicate: jest.MockedFunction<() => DedicatedRedisClient>;
};

type DedicatedRedisClient = {
    connect: jest.MockedFunction<() => Promise<void>>;
    blPop: jest.MockedFunction<
        (
            key: string,
            timeoutSeconds: number,
        ) => Promise<{ key: string; element: string } | null>
    >;
    close: jest.MockedFunction<() => Promise<void>>;
};

const mockCreateClient = jest.fn<(...args: unknown[]) => RedisClient>();
const mockRedisLoggerDebug = jest.fn<(...args: unknown[]) => void>();
const mockRedisLoggerError = jest.fn<(...args: unknown[]) => void>();

jest.mock("redis", () => ({
    createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("../logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockRedisLoggerDebug(...args),
        error: (...args: unknown[]) => mockRedisLoggerError(...args),
    },
}));

jest.mock("../../config", () => ({
    config: {
        redisUrl: "redis://mock:6379",
    },
}));

describe("redisClient", () => {
    let handlers: Record<string, (...args: unknown[]) => void>;
    let client: RedisClient;
    let dedicatedClient: DedicatedRedisClient;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();

        handlers = {};
        client = {} as RedisClient;
        client.on = jest.fn(
            (event: string, handler: (...args: unknown[]) => void) => {
                handlers[event] = handler;
                return client;
            },
        );
        client.connect = jest.fn(async () => undefined);
        dedicatedClient = {
            connect: jest.fn(async () => undefined),
            blPop: jest.fn(async () => null),
            close: jest.fn(async () => undefined),
        };
        client.duplicate = jest.fn(() => dedicatedClient);

        mockCreateClient.mockReturnValue(client);
    });

    it("creates the client with the configured Redis URL", async () => {
        const { redisClient } = await import("../redis");

        expect(redisClient).toBe(client);
        expect(mockCreateClient).toHaveBeenCalledTimes(1);
        expect(mockCreateClient).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "redis://mock:6379",
                socket: expect.objectContaining({
                    connectTimeout: 10_000,
                    reconnectStrategy: expect.any(Function),
                }),
            }),
        );
    });

    it("uses exponential backoff capped at 30 seconds", async () => {
        await import("../redis");

        const [options] = mockCreateClient.mock.calls[0] as [
            {
                socket: {
                    reconnectStrategy: (retries: number) => number;
                };
            },
        ];
        const reconnectStrategy = options.socket.reconnectStrategy as (
            retries: number,
        ) => number;

        expect(reconnectStrategy(0)).toBe(250);
        expect(reconnectStrategy(1)).toBe(500);
        expect(reconnectStrategy(2)).toBe(1_000);
        expect(reconnectStrategy(7)).toBe(30_000);
        expect(reconnectStrategy(12)).toBe(30_000);

        expect(mockRedisLoggerDebug).toHaveBeenCalledWith(
            "Redis reconnect attempt 1 – retrying in 250ms",
        );
        expect(mockRedisLoggerDebug).toHaveBeenCalledWith(
            "Redis reconnect attempt 8 – retrying in 30000ms",
        );
    });

    it("registers handlers for Redis lifecycle events", async () => {
        await import("../redis");

        expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
        expect(client.on).toHaveBeenCalledWith("end", expect.any(Function));
        expect(client.on).toHaveBeenCalledWith(
            "reconnecting",
            expect.any(Function),
        );
        expect(client.on).toHaveBeenCalledWith("ready", expect.any(Function));
    });

    it("logs Redis errors without throwing", async () => {
        await import("../redis");

        expect(() => handlers.error(new Error("boom"))).not.toThrow();
        expect(mockRedisLoggerError).toHaveBeenCalledWith(
            "Redis error:",
            "boom",
        );
    });

    it("does not eagerly connect under Jest", async () => {
        await import("../redis");

        expect(client.connect).not.toHaveBeenCalled();
    });

    it("connects immediately on module load", async () => {
        const jestWorkerId = process.env.JEST_WORKER_ID;

        try {
            delete process.env.JEST_WORKER_ID;
            jest.resetModules();
            await import("../redis");

            expect(client.connect).toHaveBeenCalledTimes(1);
        } finally {
            process.env.JEST_WORKER_ID = jestWorkerId;
        }
    });

    it("logs initial connection failures without crashing", async () => {
        client.connect.mockRejectedValue(new Error("offline"));
        const jestWorkerId = process.env.JEST_WORKER_ID;

        try {
            delete process.env.JEST_WORKER_ID;
            jest.resetModules();
            await expect(import("../redis")).resolves.toEqual(
                expect.objectContaining({
                    redisClient: client,
                }),
            );
            await Promise.resolve();

            expect(client.connect).toHaveBeenCalledTimes(1);
            expect(mockRedisLoggerError).toHaveBeenCalledWith(
                "Redis initial connection failed:",
                "offline",
            );
            expect(mockRedisLoggerDebug).toHaveBeenCalledWith(
                "Redis will continue retrying in the background...",
            );
        } finally {
            process.env.JEST_WORKER_ID = jestWorkerId;
        }
    });

    it("runs blocking BLPOP on a dedicated connection", async () => {
        const value = { key: "k", element: "payload" };
        dedicatedClient.blPop.mockResolvedValue(value);
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).resolves.toEqual(value);

        expect(client.duplicate).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.connect).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.blPop).toHaveBeenCalledWith("k", 30);
        expect(
            dedicatedClient.connect.mock.invocationCallOrder[0],
        ).toBeLessThan(dedicatedClient.blPop.mock.invocationCallOrder[0]);
        expect(dedicatedClient.close).toHaveBeenCalledTimes(1);
    });

    it("closes the dedicated connection after a BLPOP timeout", async () => {
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).resolves.toBeNull();

        expect(dedicatedClient.close).toHaveBeenCalledTimes(1);
    });

    it("closes the dedicated connection after a BLPOP error", async () => {
        const error = new Error("BLPOP failed");
        dedicatedClient.blPop.mockRejectedValue(error);
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).rejects.toBe(error);

        expect(dedicatedClient.close).toHaveBeenCalledTimes(1);
    });

    it("swallows close failures after a successful BLPOP", async () => {
        const value = { key: "k", element: "payload" };
        dedicatedClient.blPop.mockResolvedValue(value);
        dedicatedClient.close.mockRejectedValue(new Error("close failed"));
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).resolves.toEqual(value);

        expect(dedicatedClient.close).toHaveBeenCalledTimes(1);
    });
});
