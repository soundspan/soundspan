export {};

const mockRedisConstructor = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("ioredis", () => ({
    __esModule: true,
    default: function MockRedis(...args: unknown[]) {
        return mockRedisConstructor(...args);
    },
}));

jest.mock("../logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

jest.mock("../../config", () => ({
    config: {
        redisUrl: "redis://mock:6379",
    },
}));

describe("createIORedisClient", () => {
    let handlers: Record<string, (...args: any[]) => void>;
    let client: { on: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();

        handlers = {};
        client = {
            on: jest.fn((event: string, handler: (...args: any[]) => void) => {
                handlers[event] = handler;
                return client;
            }),
        };
        mockRedisConstructor.mockReturnValue(client);
    });

    it("creates a Redis client with defaults, overrides, and retry backoff", async () => {
        const { createIORedisClient } = await import("../ioredis");
        const instance = createIORedisClient("sync", {
            maxRetriesPerRequest: 7,
            connectTimeout: 5000,
        });

        expect(instance).toBe(client as any);
        expect(mockRedisConstructor).toHaveBeenCalledTimes(1);

        const [url, options] = mockRedisConstructor.mock.calls[0];
        expect(url).toBe("redis://mock:6379");
        expect(options).toEqual(
            expect.objectContaining({
                maxRetriesPerRequest: 7,
                connectTimeout: 5000,
                enableReadyCheck: true,
                lazyConnect: false,
            })
        );

        expect(options.retryStrategy(1)).toBe(250);
        expect(options.retryStrategy(2)).toBe(500);
        expect(options.retryStrategy(9)).toBe(30000);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ioredis:sync] Reconnect attempt 1 – retrying in 250ms"
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ioredis:sync] Reconnect attempt 9 – retrying in 30000ms"
        );
    });

    it("registers event handlers that log redis lifecycle events", async () => {
        const { createIORedisClient } = await import("../ioredis");
        createIORedisClient("events");

        expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
        expect(client.on).toHaveBeenCalledWith("close", expect.any(Function));
        expect(client.on).toHaveBeenCalledWith(
            "reconnecting",
            expect.any(Function)
        );
        expect(client.on).toHaveBeenCalledWith("ready", expect.any(Function));

        handlers.error(new Error("boom"));
        handlers.close();
        handlers.reconnecting(1500);
        handlers.ready();

        expect(mockLoggerError).toHaveBeenCalledWith("[ioredis:events] Error: boom");
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ioredis:events] Connection closed"
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ioredis:events] Reconnecting in 1500ms..."
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith("[ioredis:events] Ready");
    });
});
