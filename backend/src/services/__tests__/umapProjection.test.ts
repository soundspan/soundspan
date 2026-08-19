import { jest } from "@jest/globals";

type QueryRow = {
    track_id: string;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    loudnessLufs: number | null;
    truePeakDb: number | null;
    albumLoudnessLufs: number | null;
    albumTruePeakDb: number | null;
    energy: number | null;
    valence: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
};

type MockPipeline = {
    setEx: jest.Mock;
    del: jest.Mock;
    sAdd: jest.Mock;
    expire: jest.Mock;
    exec: jest.Mock;
};

type WorkerData = { spaceId: string; sampleSize: number };
type WorkerOptions = {
    workerData?: WorkerData;
    execArgv?: string[];
    resourceLimits?: { maxOldGenerationSizeMb?: number };
};

const mockRedisGet = jest.fn<(key: string) => Promise<string | null>>();
const mockRedisSet =
    jest.fn<
        (
            key: string,
            value: string,
            options: { NX?: boolean; EX?: number },
        ) => Promise<string | null>
    >();
const mockRedisSetEx =
    jest.fn<
        (
            key: string,
            ttlSeconds: number,
            value: string,
        ) => Promise<string | null>
    >();
const mockRedisEval =
    jest.fn<
        (
            script: string,
            options: { keys: string[]; arguments: string[] },
        ) => Promise<number>
    >();
const mockRedisIncr = jest.fn<(key: string) => Promise<number>>();
const mockRedisExpire =
    jest.fn<(key: string, ttlSeconds: number) => Promise<boolean>>();
const mockRedisDel = jest.fn<(keys: string | string[]) => Promise<number>>();
const mockRedisMulti = jest.fn<() => MockPipeline>();
const mockExistsSync = jest.fn<(candidatePath: string) => boolean>();
const mockPathJoin = jest.fn<(...parts: string[]) => string>();
const mockLoggerDebug = jest.fn<(...args: unknown[]) => void>();
const mockLoggerInfo = jest.fn<(...args: unknown[]) => void>();
const mockLoggerWarn = jest.fn<(...args: unknown[]) => void>();
const mockLoggerError = jest.fn<(...args: unknown[]) => void>();
const mockGetActiveSpace = jest.fn<() => Promise<{ id: string }>>();

let pipeline: MockPipeline;
let workerBehavior: ((worker: MockWorker, index: number) => void) | null = null;
let workers: MockWorker[] = [];
let workerOptions: WorkerOptions[] = [];

class MockWorker {
    listeners = new Map<string, Array<(payload?: unknown) => void>>();
    terminate = jest.fn(async () => 0);

    constructor(_filename: string, options: WorkerOptions) {
        workers.push(this);
        workerOptions.push(options);
        const index = workers.length - 1;
        setImmediate(() => workerBehavior?.(this, index));
    }

    on(event: string, listener: (payload?: unknown) => void): this {
        const listeners = this.listeners.get(event) ?? [];
        listeners.push(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    emit(event: string, payload?: unknown): void {
        for (const listener of this.listeners.get(event) ?? [])
            listener(payload);
    }
}

jest.mock("fs", () => ({
    existsSync: (candidatePath: string) => mockExistsSync(candidatePath),
}));
jest.mock("path", () => ({
    __esModule: true,
    default: { join: (...parts: string[]) => mockPathJoin(...parts) },
}));
jest.mock("../../config", () => ({
    config: { vibeMapWorkerMemoryMb: 512 },
}));
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: (key: string) => mockRedisGet(key),
        set: (
            key: string,
            value: string,
            options: { NX?: boolean; EX?: number },
        ) => mockRedisSet(key, value, options),
        setEx: (key: string, ttlSeconds: number, value: string) =>
            mockRedisSetEx(key, ttlSeconds, value),
        eval: (
            script: string,
            options: { keys: string[]; arguments: string[] },
        ) => mockRedisEval(script, options),
        incr: (key: string) => mockRedisIncr(key),
        expire: (key: string, ttlSeconds: number) =>
            mockRedisExpire(key, ttlSeconds),
        del: (keys: string | string[]) => mockRedisDel(keys),
        multi: () => mockRedisMulti(),
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: (...args: unknown[]) => mockLoggerDebug(...args),
            info: (...args: unknown[]) => mockLoggerInfo(...args),
            warn: (...args: unknown[]) => mockLoggerWarn(...args),
            error: (...args: unknown[]) => mockLoggerError(...args),
        }),
    },
}));
jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: () => mockGetActiveSpace(),
}));
jest.mock("worker_threads", () => ({ Worker: MockWorker }));

const SPACE_ID = "space-active";
const PROJECTION_KEY = `vibe:map:v5:projection:${SPACE_ID}`;
const TRACK_IDS_KEY = `vibe:map:v5:track_ids:${SPACE_ID}`;
const LEASE_KEY = `vibe-map:build-lease:${SPACE_ID}`;
const FAILURE_KEY = `vibe-map:build-failed:${SPACE_ID}`;
const FAILURE_COUNT_KEY = `vibe-map:build-failure-count:${SPACE_ID}`;

function makeRow(index: number, overrides: Partial<QueryRow> = {}): QueryRow {
    return {
        track_id: `track-${index}`,
        title: `Track ${index}`,
        artistName: `Artist ${index}`,
        artistId: `artist-${index}`,
        albumId: `album-${index}`,
        coverUrl: null,
        loudnessLufs: null,
        truePeakDb: null,
        albumLoudnessLufs: null,
        albumTruePeakDb: null,
        energy: 0.5,
        valence: 0.5,
        moodHappy: 0.1,
        moodSad: 0.2,
        moodRelaxed: 0.3,
        moodAggressive: 0.4,
        moodParty: 0.5,
        moodAcoustic: 0.6,
        moodElectronic: 0.7,
        ...overrides,
    };
}

function makeRows(count: number): QueryRow[] {
    return Array.from({ length: count }, (_, index) => makeRow(index + 1));
}

function emitResult(
    worker: MockWorker,
    rows: QueryRow[],
    projection: number[][] | null,
) {
    worker.emit("message", { type: "materialized", rowCount: rows.length });
    worker.emit("message", { type: "result", rows, projection });
}

async function flushMicrotasks(turns = 10): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function cachedPayload(): {
    tracks: unknown[];
    trackCount: number;
    sampled?: boolean;
} {
    const call = pipeline.setEx.mock.calls.find(
        (entry) => entry[0] === PROJECTION_KEY,
    );
    if (!call) throw new Error("projection was never cached");
    return JSON.parse(call[2] as string) as {
        tracks: unknown[];
        trackCount: number;
        sampled?: boolean;
    };
}

function loadModule(): typeof import("../umapProjection") {
    return require("../umapProjection") as typeof import("../umapProjection");
}

describe("computeMapProjection", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        jest.useRealTimers();
        workers = [];
        workerOptions = [];
        workerBehavior = null;
        pipeline = {
            setEx: jest.fn(() => pipeline),
            del: jest.fn(() => pipeline),
            sAdd: jest.fn(() => pipeline),
            expire: jest.fn(() => pipeline),
            exec: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
        };
        mockRedisGet.mockResolvedValue(null);
        mockRedisSet.mockResolvedValue("OK");
        mockRedisSetEx.mockResolvedValue("OK");
        mockRedisEval.mockResolvedValue(1);
        mockRedisIncr.mockResolvedValue(1);
        mockRedisExpire.mockResolvedValue(true);
        mockRedisDel.mockResolvedValue(1);
        mockRedisMulti.mockReturnValue(pipeline);
        mockExistsSync.mockImplementation((candidate) =>
            candidate.endsWith("umapWorker.ts"),
        );
        mockPathJoin.mockImplementation((...parts) => parts.join("/"));
        mockGetActiveSpace.mockResolvedValue({ id: SPACE_ID });
    });

    it("returns a cached projection without acquiring a build lease", async () => {
        const cached = {
            tracks: [],
            trackCount: 0,
            computedAt: "2026-08-19T12:00:00.000Z",
        };
        mockRedisGet.mockImplementation(async (key) =>
            key === PROJECTION_KEY ? JSON.stringify(cached) : null,
        );

        await expect(loadModule().computeMapProjection()).resolves.toEqual({
            status: "ready",
            data: cached,
        });
        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
    });

    it("prevents a second replica module from building while the Redis NX lease is held", async () => {
        const firstReplica = loadModule();
        await expect(firstReplica.computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        jest.resetModules();
        mockRedisSet.mockResolvedValueOnce(null);
        const secondReplica = loadModule();
        await expect(secondReplica.computeMapProjection()).resolves.toEqual({
            status: "building",
        });

        expect(mockRedisSet).toHaveBeenNthCalledWith(
            2,
            LEASE_KEY,
            expect.any(String),
            { NX: true, EX: 3600 },
        );
        expect(workers).toHaveLength(1);

        const rows = makeRows(5);
        emitResult(
            workers[0],
            rows,
            rows.map((_, index) => [index, index]),
        );
        await flushMicrotasks();
    });

    it("refreshes and releases an acquired build lease", async () => {
        jest.useFakeTimers();
        const { acquireVibeMapBuildLease } =
            require("../vibeMapBuildState") as typeof import("../vibeMapBuildState");
        const lease = await acquireVibeMapBuildLease(SPACE_ID);
        if (!lease) throw new Error("lease was not acquired");

        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

        expect(mockRedisEval).toHaveBeenCalledWith(
            expect.stringContaining("EXPIRE"),
            {
                keys: [LEASE_KEY],
                arguments: [expect.any(String), "3600"],
            },
        );
        await lease.release();
        expect(mockRedisEval).toHaveBeenLastCalledWith(
            expect.stringContaining("DEL"),
            { keys: [LEASE_KEY], arguments: [expect.any(String)] },
        );
    });

    it("passes only bounded query parameters to the worker and releases its lease", async () => {
        const rows = makeRows(5);
        workerBehavior = (worker) =>
            emitResult(
                worker,
                rows,
                rows.map((_, index) => [index, index]),
            );

        await expect(loadModule().computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        expect(workerOptions).toEqual([
            {
                workerData: { spaceId: SPACE_ID, sampleSize: 15000 },
                execArgv: ["--import", "tsx"],
                resourceLimits: { maxOldGenerationSizeMb: 512 },
            },
        ]);
        expect(cachedPayload().trackCount).toBe(5);
        expect(pipeline.sAdd).toHaveBeenCalledWith(
            TRACK_IDS_KEY,
            rows.map((row) => row.track_id),
        );
        expect(mockRedisEval).toHaveBeenCalledWith(
            expect.stringContaining("DEL"),
            { keys: [LEASE_KEY], arguments: [expect.any(String)] },
        );
        expect(mockRedisDel).toHaveBeenCalledWith([
            FAILURE_KEY,
            FAILURE_COUNT_KEY,
        ]);
        const payload = cachedPayload() as {
            tracks: Array<{ x: number; y: number }>;
        };
        expect(payload.tracks[0]).toEqual(
            expect.objectContaining({ x: 0, y: 0 }),
        );
        expect(payload.tracks[4]).toEqual(
            expect.objectContaining({ x: 1, y: 1 }),
        );
    });

    it("caches an empty worker result for five minutes", async () => {
        workerBehavior = (worker) => emitResult(worker, [], null);
        await loadModule().computeMapProjection();
        await flushMicrotasks();

        expect(pipeline.setEx).toHaveBeenCalledWith(
            PROJECTION_KEY,
            300,
            expect.any(String),
        );
        expect(cachedPayload().trackCount).toBe(0);
    });

    it("uses a circular layout for an undersized worker result", async () => {
        const rows = makeRows(4).map((row, index) => ({
            ...row,
            moodElectronic: index === 0 ? 0.95 : row.moodElectronic,
        }));
        workerBehavior = (worker) => {
            worker.emit("message", {
                type: "materialized",
                rowCount: rows.length,
            });
            worker.emit("message", {
                type: "result",
                rows,
                projection: null,
            });
        };
        await loadModule().computeMapProjection();
        await flushMicrotasks();

        expect(cachedPayload()).toEqual(
            expect.objectContaining({ trackCount: 4 }),
        );
        expect(cachedPayload().tracks[0]).toEqual(
            expect.objectContaining({
                id: "track-1",
                dominantMood: "moodElectronic",
                moodScore: 0.95,
                x: 0.8,
                y: 0.5,
            }),
        );
    });

    it("reports a live failure marker and does not acquire a lease", async () => {
        const marker = {
            attempt: 2,
            error: "UMAP worker exited with code 2",
            failedAt: "2026-08-19T12:00:00.000Z",
            retryAt: "2026-08-19T12:15:00.000Z",
        };
        mockRedisGet.mockImplementation(async (key) =>
            key === FAILURE_KEY ? JSON.stringify(marker) : null,
        );

        await expect(loadModule().computeMapProjection()).resolves.toEqual({
            status: "failed",
            ...marker,
        });
        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
    });

    it("suppresses the next poll after a build writes its failure marker", async () => {
        let storedMarker: string | null = null;
        mockRedisGet.mockImplementation(async (key) =>
            key === FAILURE_KEY ? storedMarker : null,
        );
        mockRedisSetEx.mockImplementation(async (key, _ttl, value) => {
            if (key === FAILURE_KEY) storedMarker = value;
            return "OK";
        });
        workerBehavior = (worker) =>
            worker.emit("error", new Error("repeatable failure"));
        const { computeMapProjection } = loadModule();

        await computeMapProjection();
        await flushMicrotasks();
        const secondPoll = await computeMapProjection();

        expect(secondPoll).toEqual(
            expect.objectContaining({
                status: "failed",
                attempt: 1,
                error: "Vibe map projection build failed",
            }),
        );
        expect(workers).toHaveLength(1);
        expect(mockRedisSet).toHaveBeenCalledTimes(1);
    });

    it("records bounded escalating cooldowns after repeated build failures", async () => {
        mockRedisIncr
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(4);
        workerBehavior = (worker) =>
            worker.emit("error", new Error("deterministic failure"));
        const { computeMapProjection } = loadModule();

        for (let attempt = 0; attempt < 4; attempt += 1) {
            await computeMapProjection();
            await flushMicrotasks();
        }

        const markerTtls = mockRedisSetEx.mock.calls
            .filter((call) => call[0] === FAILURE_KEY)
            .map((call) => call[1]);
        expect(markerTtls).toEqual([300, 900, 3600, 3600]);
        expect(mockRedisExpire).toHaveBeenCalledTimes(4);
        expect(mockRedisExpire).toHaveBeenLastCalledWith(
            FAILURE_COUNT_KEY,
            86400,
        );
        const finalMarker = JSON.parse(
            mockRedisSetEx.mock.calls.at(-1)?.[2] as string,
        ) as { attempt: number; error: string };
        expect(finalMarker).toEqual(
            expect.objectContaining({
                attempt: 4,
                error: "Vibe map projection build failed",
            }),
        );
    });

    it("allows a fresh build after the failure marker expires", async () => {
        const rows = makeRows(5);
        workerBehavior = (worker) =>
            emitResult(
                worker,
                rows,
                rows.map((_, index) => [index, index]),
            );

        const { computeMapProjection } = loadModule();
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        expect(mockRedisGet).toHaveBeenCalledWith(FAILURE_KEY);
        expect(mockRedisSet).toHaveBeenCalledWith(
            LEASE_KEY,
            expect.any(String),
            { NX: true, EX: 3600 },
        );
        expect(cachedPayload().trackCount).toBe(5);
    });

    it("uses the worker-reported materialized count for OOM sample degradation", async () => {
        workerBehavior = (worker, index) => {
            if (index === 0) {
                worker.emit("message", {
                    type: "materialized",
                    rowCount: 4000,
                });
                const error = new Error(
                    "Worker terminated due to reaching memory limit",
                ) as NodeJS.ErrnoException;
                error.code = "ERR_WORKER_OUT_OF_MEMORY";
                worker.emit("error", error);
                return;
            }
            const rows = makeRows(2000);
            emitResult(
                worker,
                rows,
                rows.map((_, rowIndex) => [rowIndex, rowIndex]),
            );
        };

        await loadModule().computeMapProjection();
        await flushMicrotasks(20);

        expect(
            workerOptions.map((options) => options.workerData?.sampleSize),
        ).toEqual([15000, 2000]);
        expect(cachedPayload()).toEqual(
            expect.objectContaining({ trackCount: 2000, sampled: true }),
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "UMAP worker memory limit reached; retrying with a smaller sample",
            expect.objectContaining({ sampleSize: 4000 }),
        );
    });
});

describe("umapWorkerOptions", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("registers tsx only for the development TypeScript worker", () => {
        const { umapWorkerOptions } = loadModule();
        expect(
            umapWorkerOptions("/workers/umapWorker.ts", SPACE_ID, 5000),
        ).toEqual({
            workerData: { spaceId: SPACE_ID, sampleSize: 5000 },
            execArgv: ["--import", "tsx"],
        });
        expect(
            umapWorkerOptions("/workers/umapWorker.js", SPACE_ID, 5000),
        ).toEqual({
            workerData: { spaceId: SPACE_ID, sampleSize: 5000 },
        });
    });
});
