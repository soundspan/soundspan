import type { NextFunction, Request, Response } from "express";

jest.mock("../../utils/redis", () => ({
    redisClient: { isReady: false, sendCommand: jest.fn() },
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import { authLimiter } from "../rateLimiter";

function invokeAuthLimiter(): Promise<number> {
    return new Promise((resolve, reject) => {
        let statusCode = 401;
        const req = {
            app: { get: () => false },
            headers: {},
            ip: "203.0.113.20",
            method: "POST",
            originalUrl: "/login",
            path: "/login",
            socket: { remoteAddress: "203.0.113.20" },
        } as unknown as Request;
        const res = {
            headersSent: false,
            getHeader: jest.fn(),
            once: jest.fn(),
            setHeader: jest.fn(),
            status: jest.fn((nextStatus: number) => {
                statusCode = nextStatus;
                return res;
            }),
            send: jest.fn(() => resolve(statusCode)),
        } as unknown as Response;
        const next: NextFunction = (error?: unknown) => {
            if (error) reject(error);
            else resolve(statusCode);
        };
        authLimiter(req, res, next);
    });
}

describe("authLimiter Redis fallback", () => {
    it("blocks the 41st failed authentication attempt during a Redis outage", async () => {
        for (let attempt = 1; attempt <= 40; attempt += 1) {
            await expect(invokeAuthLimiter()).resolves.toBe(401);
        }

        await expect(invokeAuthLimiter()).resolves.toBe(429);
    });
});
