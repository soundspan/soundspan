import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

jest.mock("../../utils/redis", () => ({ redisClient: { eval: jest.fn() } }));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({ warn: jest.fn() }),
    },
}));
const recordFederationHostStream = jest.fn();
const recordFederationQuotaRejection = jest.fn();
jest.mock("../../metrics", () => ({
    recordFederationHostStream,
    recordFederationQuotaRejection,
}));

import {
    createStreamPacingTransform,
    FEDERATION_STREAM_COUNTER_TTL_SECONDS,
    type FederationStreamRedis,
    withFederationStreamControls,
} from "../federationStreamControls";

const MAX_TEST_LEASES = 64;

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

class LeaseSetRedis implements FederationStreamRedis {
    private readonly members = new Map<string, number>();

    seed(member: string, expiresAt: number): void {
        this.members.set(member, expiresAt);
    }

    memberIds(): string[] {
        return [...this.members.keys()].sort();
    }

    private acquire(args: string[]): number {
        const [member, limitValue, ttlMsValue] = args;
        const now = Date.now();
        const entries = [...this.members.entries()];
        for (
            let index = 0;
            index < MAX_TEST_LEASES && index < entries.length;
            index += 1
        ) {
            const [id, expiresAt] = entries[index];
            if (expiresAt <= now) this.members.delete(id);
        }
        if (this.members.size >= Number(limitValue)) return 0;
        this.members.set(member, now + Number(ttlMsValue));
        return 1;
    }

    private refresh(args: string[]): number {
        const [member, ttlMsValue] = args;
        const expiresAt = this.members.get(member);
        if (expiresAt === undefined || expiresAt <= Date.now()) {
            this.members.delete(member);
            return 0;
        }
        this.members.set(member, Date.now() + Number(ttlMsValue));
        return 1;
    }

    async eval(
        script: string,
        options: { keys: string[]; arguments: string[] },
    ): Promise<unknown> {
        if (script.includes("ZCOUNT")) return this.acquire(options.arguments);
        if (script.includes("ZSCORE")) return this.refresh(options.arguments);
        this.members.delete(options.arguments[0]);
        return 1;
    }
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
        expect(recordFederationQuotaRejection).toHaveBeenCalledWith(
            "peer-1",
            "concurrency",
        );
        expect(recordFederationHostStream).toHaveBeenCalledWith(
            "peer-1",
            "http_4xx",
        );
    });

    it.each([
        ["finish", "response end"],
        ["aborted", "request abort"],
    ] as const)("removes one lease on %s (%s)", async (event, _label) => {
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
        const leaseId = redis.eval.mock.calls[0][1].arguments[0];
        expect(redis.eval.mock.calls[0][1]).toEqual({
            keys: ["federation:stream-leases:v2:peer-1"],
            arguments: [
                leaseId,
                "1",
                String(FEDERATION_STREAM_COUNTER_TTL_SECONDS * 1_000),
                String(FEDERATION_STREAM_COUNTER_TTL_SECONDS),
            ],
        });
        expect(redis.eval.mock.calls[1][1]).toEqual({
            keys: ["federation:stream-leases:v2:peer-1"],
            arguments: [leaseId, String(FEDERATION_STREAM_COUNTER_TTL_SECONDS)],
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
        const leaseId = redis.eval.mock.calls[0][1].arguments[0];
        expect(redis.eval.mock.calls[1][1]).toEqual({
            keys: ["federation:stream-leases:v2:peer-1"],
            arguments: [
                leaseId,
                String(FEDERATION_STREAM_COUNTER_TTL_SECONDS * 1_000),
                String(FEDERATION_STREAM_COUNTER_TTL_SECONDS),
            ],
        });

        complete?.();
        await running;
    });

    it("expires a leaked lease while another stream refreshes only itself", async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
        const redis = new LeaseSetRedis();
        redis.seed(
            "leaked-replica-lease",
            Date.now() + FEDERATION_STREAM_COUNTER_TTL_SECONDS * 1_000,
        );
        let completeLive: (() => void) | undefined;
        const live = withFederationStreamControls(
            requestLifecycle(),
            responseLifecycle(),
            {
                peerId: "peer-1",
                maxConcurrentStreams: 2,
                maxStreamKbps: null,
            },
            () =>
                new Promise<void>((resolve) => {
                    completeLive = resolve;
                }),
            redis,
        );
        await Promise.resolve();

        const limited = responseLifecycle() as Response & {
            setHeader: jest.Mock;
            status: jest.Mock;
            json: jest.Mock;
        };
        limited.setHeader = jest.fn();
        limited.status = jest.fn(() => limited);
        limited.json = jest.fn(() => limited);
        await withFederationStreamControls(
            requestLifecycle(),
            limited,
            {
                peerId: "peer-1",
                maxConcurrentStreams: 2,
                maxStreamKbps: null,
            },
            jest.fn(async () => undefined),
            redis,
        );
        expect(limited.status).toHaveBeenCalledWith(429);

        await jest.advanceTimersByTimeAsync(
            FEDERATION_STREAM_COUNTER_TTL_SECONDS * 1_000 + 1,
        );
        await withFederationStreamControls(
            requestLifecycle(),
            responseLifecycle(),
            {
                peerId: "peer-1",
                maxConcurrentStreams: 2,
                maxStreamKbps: null,
            },
            async () => undefined,
            redis,
        );

        expect(redis.memberIds()).not.toContain("leaked-replica-lease");
        expect(redis.memberIds()).toHaveLength(1);
        completeLive?.();
        await live;
    });
});
