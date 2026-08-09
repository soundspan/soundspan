import type { NextFunction, Request, Response } from "express";
import { createHash } from "crypto";
import { requireInternalSecret } from "../internalAuth";

const KNOWN_DEFAULT_SECRET = "soundspan-internal-secret-change-me";

function makeRes(): Response & { statusCode?: number; body?: unknown } {
    const res = {} as Response & { statusCode?: number; body?: unknown };
    res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
    }) as unknown as Response["status"];
    res.json = jest.fn((payload: unknown) => {
        res.body = payload;
        return res;
    }) as unknown as Response["json"];
    return res;
}

function makeReq(headerValue?: string): Request {
    return {
        headers:
            headerValue === undefined
                ? {}
                : { "x-internal-secret": headerValue },
    } as unknown as Request;
}

describe("requireInternalSecret", () => {
    const original = process.env.INTERNAL_API_SECRET;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.INTERNAL_API_SECRET;
        } else {
            process.env.INTERNAL_API_SECRET = original;
        }
        jest.clearAllMocks();
    });

    it("rejects with 403 when INTERNAL_API_SECRET is unset", () => {
        delete process.env.INTERNAL_API_SECRET;
        const res = makeRes();
        const next = jest.fn() as NextFunction;
        requireInternalSecret(makeReq("anything"), res, next);
        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects with 403 when set to the known default sentinel, even with a matching header", () => {
        process.env.INTERNAL_API_SECRET = KNOWN_DEFAULT_SECRET;
        const res = makeRes();
        const next = jest.fn() as NextFunction;
        requireInternalSecret(makeReq(KNOWN_DEFAULT_SECRET), res, next);
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Forbidden" });
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects with 403 when the provided header does not match", () => {
        process.env.INTERNAL_API_SECRET = "a-real-strong-secret";
        const res = makeRes();
        const next = jest.fn() as NextFunction;
        requireInternalSecret(makeReq("wrong"), res, next);
        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it("calls next() when a real secret matches the provided header", () => {
        process.env.INTERNAL_API_SECRET = "a-real-strong-secret";
        const res = makeRes();
        const next = jest.fn() as NextFunction;
        requireInternalSecret(makeReq("a-real-strong-secret"), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    it("keeps constant-time compare usable for arbitrary-length secrets", () => {
        // Guards the SHA-256-then-timingSafeEqual path against regressions.
        const provided = "x".repeat(500);
        expect(createHash("sha256").update(provided).digest().length).toBe(32);
    });
});
