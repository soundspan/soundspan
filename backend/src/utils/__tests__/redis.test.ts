import { jest } from "@jest/globals";

type RedisClient = {
    on: jest.MockedFunction<
        (event: string, handler: (...args: unknown[]) => void) => RedisClient
    >;
    connect: jest.MockedFunction<() => Promise<void>>;
    duplicate: jest.MockedFunction<
        (options?: Record<string, unknown>) => DedicatedRedisClient
    >;
};

type DedicatedRedisClient = {
    isOpen: boolean;
    on: jest.MockedFunction<
        (
            event: string,
            handler: (...args: unknown[]) => void,
        ) => DedicatedRedisClient
    >;
    connect: jest.MockedFunction<() => Promise<void>>;
    blPop: jest.MockedFunction<
        (
            key: string,
            timeoutSeconds: number,
        ) => Promise<{ key: string; element: string } | null>
    >;
    close: jest.MockedFunction<() => Promise<void>>;
    destroy: jest.MockedFunction<() => void>;
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
        dedicatedClient = {} as DedicatedRedisClient;
        dedicatedClient.on = jest.fn(() => dedicatedClient);
        Object.assign(dedicatedClient, {
            isOpen: false,
            connect: jest.fn(async () => undefined),
            blPop: jest.fn(async () => null),
            close: jest.fn(async () => undefined),
            destroy: jest.fn(),
        });
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

    it("reuses one dedicated connection for repeated blocking pops", async () => {
        const value = { key: "k", element: "payload" };
        dedicatedClient.blPop.mockResolvedValue(value);
        const { blockingBlPop, closeBlockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).resolves.toEqual(value);
        dedicatedClient.isOpen = true;
        await expect(blockingBlPop("k", 30)).resolves.toEqual(value);

        expect(client.duplicate).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.connect).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.blPop).toHaveBeenCalledTimes(2);
        expect(
            dedicatedClient.connect.mock.invocationCallOrder[0],
        ).toBeLessThan(dedicatedClient.blPop.mock.invocationCallOrder[0]);
        expect(dedicatedClient.close).not.toHaveBeenCalled();
        await closeBlockingBlPop("k");
        expect(dedicatedClient.destroy).toHaveBeenCalledTimes(1);
    });

    it("bounds dedicated reconnect attempts with exponential backoff", async () => {
        const { blockingBlPop, closeBlockingBlPop } = await import("../redis");
        await blockingBlPop("k", 30);

        const [options] = client.duplicate.mock.calls[0] as [
            {
                socket: {
                    reconnectStrategy: (retries: number) => number | Error;
                };
            },
        ];
        const reconnectStrategy = options.socket.reconnectStrategy;

        expect(reconnectStrategy(0)).toBe(250);
        expect(reconnectStrategy(1)).toBe(500);
        expect(reconnectStrategy(4)).toBe(4_000);
        expect(reconnectStrategy(5)).toEqual(expect.any(Error));

        await closeBlockingBlPop("k");
        expect(reconnectStrategy(0)).toEqual(expect.any(Error));
    });

    it.each([
        ["", 30],
        ["k", 0],
        ["k", 301],
        ["k", 1.5],
    ])("rejects invalid blocking pop inputs (%s, %s)", async (key, timeout) => {
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop(key, timeout)).rejects.toEqual(
            expect.any(Error),
        );
        expect(client.duplicate).not.toHaveBeenCalled();
    });

    it("discards a failed blocking connection and recreates it on the next pop", async () => {
        const error = new Error("BLPOP failed");
        const recoveredClient = {} as DedicatedRedisClient;
        recoveredClient.on = jest.fn(() => recoveredClient);
        Object.assign(recoveredClient, {
            isOpen: false,
            connect: jest.fn(async () => undefined),
            blPop: jest.fn(async () => ({ key: "k", element: "recovered" })),
            close: jest.fn(async () => undefined),
            destroy: jest.fn(),
        });
        dedicatedClient.blPop.mockRejectedValue(error);
        client.duplicate
            .mockReturnValueOnce(dedicatedClient)
            .mockReturnValueOnce(recoveredClient);
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).rejects.toBe(error);
        await expect(blockingBlPop("k", 30)).resolves.toEqual({
            key: "k",
            element: "recovered",
        });

        expect(dedicatedClient.destroy).toHaveBeenCalledTimes(1);
        expect(client.duplicate).toHaveBeenCalledTimes(2);
        expect(recoveredClient.connect).toHaveBeenCalledTimes(1);
    });

    it("discards a dedicated connection when connect rejects", async () => {
        const error = new Error("connect failed");
        dedicatedClient.connect.mockRejectedValue(error);
        const { blockingBlPop } = await import("../redis");

        await expect(blockingBlPop("k", 30)).rejects.toBe(error);

        expect(dedicatedClient.destroy).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.blPop).not.toHaveBeenCalled();
    });

    it("destroys without awaiting an in-flight connection attempt", async () => {
        const shutdownError = new Error("connection destroyed");
        let rejectConnect!: (reason?: unknown) => void;
        dedicatedClient.connect.mockImplementation(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectConnect = reject;
                }),
        );
        dedicatedClient.destroy.mockImplementation(() => {
            rejectConnect(shutdownError);
        });
        const { blockingBlPop, closeBlockingBlPop } = await import("../redis");
        const pop = blockingBlPop("k", 30);
        const rejectedPop = expect(pop).rejects.toBe(shutdownError);
        await Promise.resolve();

        await expect(closeBlockingBlPop("k")).resolves.toBeUndefined();
        await rejectedPop;

        expect(dedicatedClient.destroy).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.blPop).not.toHaveBeenCalled();
    });

    it("destroys a blocking connection immediately during shutdown", async () => {
        const { blockingBlPop, closeBlockingBlPop } = await import("../redis");

        await blockingBlPop("k", 30);
        dedicatedClient.isOpen = true;
        await expect(closeBlockingBlPop("k")).resolves.toBeUndefined();

        expect(dedicatedClient.destroy).toHaveBeenCalledTimes(1);
        expect(dedicatedClient.close).not.toHaveBeenCalled();
    });
});
