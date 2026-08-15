import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

jest.mock("../../utils/redis", () => ({ redisClient: { eval: jest.fn() } }));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({ warn: jest.fn() }),
    },
}));

import {
    createStreamPacingTransform,
    FEDERATION_STREAM_COUNTER_TTL_SECONDS,
    type FederationStreamRedis,
    withFederationStreamControls,
} from "../federationStreamControls";

function requestLifecycle(): Request {
    return new EventEmitter() as Request;
}

function responseLifecycle(): Response {
    return new EventEmitter() as Response;
}

function redisWithResults(...results: number[]) {
    const evalCommand: jest.MockedFunction<FederationStreamRedis["eval"]> =
        jest.fn(
            async (
                _script: string,
                _options: { keys: string[]; arguments: string[] },
            ) => results.shift() ?? 0,
        );
    return {
        eval: evalCommand,
    };
}

describe("federation stream controls", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("rejects a stream above the multi-replica peer limit with retry guidance", async () => {
        const redis = redisWithResults(0);
        const req = requestLifecycle();
        const res = responseLifecycle() as Response & {
            setHeader: jest.Mock;
            status: jest.Mock;
            json: jest.Mock;
        };
        res.setHeader = jest.fn();
        res.status = jest.fn(() => res);
        res.json = jest.fn(() => res);
        const operation = jest.fn();

        await withFederationStreamControls(
            req,
            res,
            {
                peerId: "peer-1",
                maxConcurrentStreams: 1,
                maxStreamKbps: null,
            },
            operation,
            redis,
        );

        expect(operation).not.toHaveBeenCalled();
        expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({
            error: "Federation peer stream limit exceeded",
            code: "FEDERATION_STREAM_LIMIT",
            retryAfterSeconds: 1,
        });
    });

    it.each([
        ["finish", "response end"],
        ["aborted", "request abort"],
    ] as const)("decrements once on %s (%s)", async (event, _label) => {
        const redis = redisWithResults(1, 1);
        const req = requestLifecycle();
        const res = responseLifecycle();
        let complete: (() => void) | undefined;
        const operation = jest.fn(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                }),
        );
        const running = withFederationStreamControls(
            req,
            res,
            {
                peerId: "peer-1",
                maxConcurrentStreams: 1,
                maxStreamKbps: null,
            },
            operation,
            redis,
        );

        await Promise.resolve();
        (event === "aborted" ? req : res).emit(event);
        await Promise.resolve();
        complete?.();
        await running;

        expect(redis.eval).toHaveBeenCalledTimes(2);
        expect(redis.eval.mock.calls[0][1]).toEqual({
            keys: ["federation:stream-count:v1:peer-1"],
            arguments: ["1", String(FEDERATION_STREAM_COUNTER_TTL_SECONDS)],
        });
        expect(redis.eval.mock.calls[1][1]).toEqual({
            keys: ["federation:stream-count:v1:peer-1"],
            arguments: [String(FEDERATION_STREAM_COUNTER_TTL_SECONDS)],
        });
    });

    it("paces output to one bounded byte window", async () => {
        jest.useFakeTimers();
        const transform = createStreamPacingTransform(64);
        const chunks: Buffer[] = [];
        transform.on("data", (chunk: Buffer) => chunks.push(chunk));

        transform.end(Buffer.alloc(1_600));
        await Promise.resolve();
        expect(chunks.map((chunk) => chunk.byteLength)).toEqual([800]);

        await jest.advanceTimersByTimeAsync(100);
        expect(chunks.map((chunk) => chunk.byteLength)).toEqual([800, 800]);
    });

    it("refreshes the crash-recovery TTL while a stream remains active", async () => {
        jest.useFakeTimers();
        const redis = redisWithResults(1, 1, 0);
        const req = requestLifecycle();
        const res = responseLifecycle();
        let complete: (() => void) | undefined;
        const running = withFederationStreamControls(
            req,
            res,
            {
                peerId: "peer-1",
                maxConcurrentStreams: 1,
                maxStreamKbps: null,
            },
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                }),
            redis,
        );
        await Promise.resolve();

        await jest.advanceTimersByTimeAsync(20_000);
        expect(redis.eval.mock.calls[1][1]).toEqual({
            keys: ["federation:stream-count:v1:peer-1"],
            arguments: [String(FEDERATION_STREAM_COUNTER_TTL_SECONDS)],
        });

        complete?.();
        await running;
    });
});
