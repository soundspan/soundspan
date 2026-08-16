import express from "express";
import rateLimit, {
    type Options as ExpressRateLimitOptions,
    type Store,
} from "express-rate-limit";
import type { Logger } from "../../utils/logger";
import {
    createRedisRateLimitOptions,
    type RateLimitRedisClient,
} from "../rateLimitStore";

jest.mock("../../utils/redis", () => ({
    redisClient: { isReady: false, sendCommand: jest.fn() },
}));

type Counter = Readonly<{ count: number; expiresAt: number }>;

class FakeRedis implements RateLimitRedisClient {
    readonly keys = new Map<string, Counter>();
    readonly isReady = true;

    async sendCommand(args: readonly string[]): Promise<unknown> {
        const command = args[0]?.toUpperCase();
        if (command === "EVAL") {
            return this.increment(args);
        }
        if (command === "DECR") {
            return this.decrement(args[1]);
        }
        if (command === "DEL") {
            return this.keys.delete(this.requireKey(args[1])) ? 1 : 0;
        }
        throw new Error(`Unsupported fake Redis command: ${command}`);
    }

    private increment(args: readonly string[]): [number, number] {
        const key = this.requireKey(args[3]);
        const windowMs = Number(args[4]);
        const now = Date.now();
        const current = this.keys.get(key);
        const count =
            !current || current.expiresAt <= now ? 1 : current.count + 1;
        const expiresAt =
            !current || current.expiresAt <= now
                ? now + windowMs
                : current.expiresAt;
        this.keys.set(key, { count, expiresAt });
        return [count, expiresAt - now];
    }

    private decrement(keyValue: string | undefined): number {
        const key = this.requireKey(keyValue);
        const current = this.keys.get(key);
        if (!current) return -1;
        const count = current.count - 1;
        this.keys.set(key, { ...current, count });
        return count;
    }

    private requireKey(value: string | undefined): string {
        if (!value) throw new Error("Fake Redis command is missing a key");
        return value;
    }
}

function createMockLogger(): { root: Logger; scoped: jest.Mocked<Logger> } {
    const scoped: jest.Mocked<Logger> = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    scoped.child.mockReturnValue(scoped);
    const root: Logger = { ...scoped, child: jest.fn(() => scoped) };
    return { root, scoped };
}

function createApp(client: RateLimitRedisClient, max = 2) {
    const app = express();
    app.use(
        rateLimit({
            windowMs: 60_000,
            max,
            standardHeaders: true,
            legacyHeaders: false,
            ...createRedisRateLimitOptions("auth", { client }),
        }),
    );
    return app;
}

type CapturedMiddleware = (
    req: unknown,
    res: unknown,
    next: (error?: unknown) => void,
) => void;

function getAppMiddleware(
    app: express.Express,
    index: number,
): CapturedMiddleware {
    const router: unknown = Reflect.get(app, "router");
    if (
        (typeof router !== "object" && typeof router !== "function") ||
        router === null
    ) {
        throw new TypeError("Express router was not initialized");
    }
    const stack: unknown = Reflect.get(router, "stack");
    if (!Array.isArray(stack)) {
        throw new TypeError("Express router stack is unavailable");
    }
    const layer: unknown = stack[index];
    if (typeof layer !== "object" || layer === null) {
        throw new RangeError("Express middleware layer is unavailable");
    }
    const middleware: unknown = Reflect.get(layer, "handle");
    if (typeof middleware !== "function") {
        throw new TypeError("Express middleware handler is unavailable");
    }
    return middleware as CapturedMiddleware;
}

async function invokeApp(app: express.Express, index = 0): Promise<number> {
    const middleware = getAppMiddleware(app, index);
    return new Promise<number>((resolve, reject) => {
        let statusCode = 200;
        const req = {
            app,
            headers: {},
            ip: "203.0.113.10",
            method: "GET",
            originalUrl: "/",
            path: "/",
        };
        type FakeResponse = {
            headersSent: boolean;
            setHeader: jest.Mock;
            getHeader: jest.Mock;
            once: jest.Mock;
            status: jest.Mock<FakeResponse, [number]>;
            send: jest.Mock<void, []>;
        };
        const res: FakeResponse = {
            headersSent: false,
            setHeader: jest.fn(),
            getHeader: jest.fn(),
            once: jest.fn(),
            status: jest.fn((nextStatus: number): FakeResponse => {
                statusCode = nextStatus;
                return res;
            }),
            send: jest.fn(() => resolve(statusCode)),
        };
        middleware(req, res, (error?: unknown) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(204);
        });
    });
}

describe("Redis rate-limit store", () => {
    it("supports decrementing and resetting a counter", async () => {
        const redis = new FakeRedis();
        const { store: configuredStore } = createRedisRateLimitOptions("auth", {
            client: redis,
        });
        const store = configuredStore as Store;
        store.init?.({ windowMs: 60_000 } as ExpressRateLimitOptions);

        await expect(store.increment("client-1")).resolves.toMatchObject({
            totalHits: 1,
        });
        await store.decrement("client-1");
        await expect(store.increment("client-1")).resolves.toMatchObject({
            totalHits: 1,
        });
        await store.resetKey("client-1");
        await expect(store.increment("client-1")).resolves.toMatchObject({
            totalHits: 1,
        });
    });

    it("enforces one combined budget across separate app instances", async () => {
        const redis = new FakeRedis();
        const firstApp = createApp(redis);
        const secondApp = createApp(redis);

        await expect(invokeApp(firstApp)).resolves.toBe(204);
        await expect(invokeApp(secondApp)).resolves.toBe(204);
        await expect(invokeApp(firstApp)).resolves.toBe(429);

        expect([...redis.keys.keys()]).toEqual(["rl:auth:203.0.113.10"]);
    });

    it("keeps limiter namespaces independent", async () => {
        const redis = new FakeRedis();
        const app = express();
        app.use(
            "/auth",
            rateLimit({
                windowMs: 60_000,
                max: 1,
                ...createRedisRateLimitOptions("auth", { client: redis }),
            }),
        );
        app.use(
            "/oidc",
            rateLimit({
                windowMs: 60_000,
                max: 1,
                ...createRedisRateLimitOptions("oidc-flow", { client: redis }),
            }),
        );

        await expect(invokeApp(app)).resolves.toBe(204);
        await expect(invokeApp(app, 1)).resolves.toBe(204);

        expect([...redis.keys.keys()].sort()).toEqual([
            "rl:auth:203.0.113.10",
            "rl:oidc-flow:203.0.113.10",
        ]);
    });

    it("fails open and rate-limits warning logs when Redis rejects commands", async () => {
        const client: RateLimitRedisClient = {
            isReady: true,
            sendCommand: jest.fn().mockRejectedValue(new Error("Redis down")),
        };
        const { root, scoped } = createMockLogger();
        const app = express();
        app.use(
            rateLimit({
                windowMs: 60_000,
                max: 1,
                ...createRedisRateLimitOptions("auth", {
                    client,
                    logger: root,
                }),
            }),
        );
        await expect(invokeApp(app)).resolves.toBe(204);
        await expect(invokeApp(app)).resolves.toBe(204);

        expect(scoped.warn).toHaveBeenCalledTimes(1);
        expect(scoped.warn).toHaveBeenCalledWith(
            "Redis rate-limit store unavailable; allowing request",
            expect.objectContaining({
                limiter: "auth",
                error: "Error: Redis down",
            }),
        );
    });

    it("fails open before the shared Redis client is ready", async () => {
        const client: RateLimitRedisClient = {
            isReady: false,
            sendCommand: jest.fn(),
        };
        const { root, scoped } = createMockLogger();
        const app = express();
        app.use(
            rateLimit({
                windowMs: 60_000,
                max: 1,
                ...createRedisRateLimitOptions("auth", {
                    client,
                    logger: root,
                }),
            }),
        );
        await expect(invokeApp(app)).resolves.toBe(204);

        expect(client.sendCommand).not.toHaveBeenCalled();
        expect(scoped.warn).toHaveBeenCalledTimes(1);
    });

    it("bounds a hung Redis command and fails open", async () => {
        const client: RateLimitRedisClient = {
            isReady: true,
            sendCommand: jest.fn(() => new Promise(() => undefined)),
        };
        const { root, scoped } = createMockLogger();
        const app = express();
        app.use(
            rateLimit({
                windowMs: 60_000,
                max: 1,
                ...createRedisRateLimitOptions("auth", {
                    client,
                    logger: root,
                    commandTimeoutMs: 20,
                }),
            }),
        );
        await expect(invokeApp(app)).resolves.toBe(204);

        expect(scoped.warn).toHaveBeenCalledWith(
            "Redis rate-limit store unavailable; allowing request",
            expect.objectContaining({
                limiter: "auth",
                error: "Error: Redis rate-limit command timed out after 20ms",
            }),
        );
    });
});
