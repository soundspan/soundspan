import { jest } from "@jest/globals";

type MockPipeline = {
    setEx: jest.Mock;
    del: jest.Mock;
    sAdd: jest.Mock;
    expire: jest.Mock;
    exec: jest.Mock;
};

type QueryRow = {
    track_id: string;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    energy: number | null;
    valence: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
    embedding: string;
};

const mockQueryRaw = jest.fn<(...args: unknown[]) => Promise<QueryRow[]>>();
const mockRedisGet = jest.fn<(...args: unknown[]) => Promise<string | null>>();
const mockRedisMulti = jest.fn<(...args: unknown[]) => MockPipeline>();
const mockExistsSync = jest.fn<(candidatePath: string) => boolean>();
const mockPathJoin = jest.fn<(...parts: string[]) => string>();
const mockParseEmbedding = jest.fn<(embedding: string) => number[]>();
const mockUmapLoggerDebug = jest.fn<(...args: unknown[]) => void>();
const mockUmapLoggerInfo = jest.fn<(...args: unknown[]) => void>();
const mockUmapLoggerWarn = jest.fn<(...args: unknown[]) => void>();
const mockUmapLoggerError = jest.fn<(...args: unknown[]) => void>();

let pipeline: MockPipeline;
let workerBehavior: ((worker: MockWorker) => void) | null = null;
let workers: MockWorker[] = [];
let lastWorkerFilename: string | null = null;
let lastWorkerOptions: { workerData?: { embeddings: number[][]; nNeighbors: number } } | null = null;

class MockWorker {
    listeners = new Map<string, Array<(payload?: unknown) => void>>();
    terminate = jest.fn(async () => 0);

    constructor(filename: string, options: { workerData?: { embeddings: number[][]; nNeighbors: number } }) {
        lastWorkerFilename = filename;
        lastWorkerOptions = options;
        workers.push(this);

        setImmediate(() => {
            workerBehavior?.(this);
        });
    }

    on(event: string, listener: (payload?: unknown) => void): this {
        const listeners = this.listeners.get(event) ?? [];
        listeners.push(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    emit(event: string, payload?: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(payload);
        }
    }
}

jest.mock("fs", () => ({
    existsSync: (candidatePath: string) => mockExistsSync(candidatePath),
}));

jest.mock("path", () => ({
    __esModule: true,
    default: {
        join: (...args: string[]) => mockPathJoin(...args),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: (...args: unknown[]) => mockRedisGet(...args),
        multi: (...args: unknown[]) => mockRedisMulti(...args),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockUmapLoggerDebug(...args),
        info: (...args: unknown[]) => mockUmapLoggerInfo(...args),
        warn: (...args: unknown[]) => mockUmapLoggerWarn(...args),
        error: (...args: unknown[]) => mockUmapLoggerError(...args),
    },
}));

jest.mock("../../utils/embedding", () => ({
    parseEmbedding: (embedding: string) => mockParseEmbedding(embedding),
}));

jest.mock("worker_threads", () => ({
    Worker: MockWorker,
}));

function makeRow(index: number, overrides: Partial<QueryRow> = {}): QueryRow {
    return {
        track_id: `track-${index}`,
        title: `Track ${index}`,
        artistName: `Artist ${index}`,
        artistId: `artist-${index}`,
        albumId: `album-${index}`,
        coverUrl: index % 2 === 0 ? `cover-${index}.jpg` : null,
        energy: Number((index / 10).toFixed(2)),
        valence: Number((1 - index / 10).toFixed(2)),
        moodHappy: 0.1,
        moodSad: 0.2,
        moodRelaxed: 0.3,
        moodAggressive: 0.4,
        moodParty: 0.5,
        moodAcoustic: 0.6,
        moodElectronic: 0.7,
        embedding: `[${index},${index + 1},${index + 2}]`,
        ...overrides,
    };
}

function makeRows(count: number): QueryRow[] {
    return Array.from({ length: count }, (_, index) => makeRow(index + 1));
}

async function flushMicrotasks(turns = 4): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
    }
}

function loadModule(): typeof import("../umapProjection") {
    return require("../umapProjection") as typeof import("../umapProjection");
}

describe("computeMapProjection", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        jest.useRealTimers();

        workerBehavior = null;
        workers = [];
        lastWorkerFilename = null;
        lastWorkerOptions = null;

        pipeline = {
            setEx: jest.fn<(...args: unknown[]) => MockPipeline>(() => pipeline),
            del: jest.fn<(...args: unknown[]) => MockPipeline>(() => pipeline),
            sAdd: jest.fn<(...args: unknown[]) => MockPipeline>(() => pipeline),
            expire: jest.fn<(...args: unknown[]) => MockPipeline>(() => pipeline),
            exec: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
        };

        mockRedisGet.mockResolvedValue(null);
        mockRedisMulti.mockReturnValue(pipeline);
        mockQueryRaw.mockResolvedValue([]);
        mockExistsSync.mockImplementation((candidatePath: string) => candidatePath.endsWith("umapWorker.ts"));
        mockPathJoin.mockImplementation((...parts: string[]) => parts.join("/").replace(/\/+/g, "/"));
        mockParseEmbedding.mockImplementation((embedding: string) => JSON.parse(embedding) as number[]);
    });

    it("returns cached projection data without querying the database", async () => {
        const cached = {
            tracks: [{ id: "track-1", x: 0.1, y: 0.2 }],
            trackCount: 1,
            computedAt: "2026-03-14T12:00:00.000Z",
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const { computeMapProjection } = loadModule();

        await expect(computeMapProjection()).resolves.toEqual(cached);
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockRedisMulti).not.toHaveBeenCalled();
        expect(mockUmapLoggerDebug).toHaveBeenCalledWith("[VIBE-MAP] Cache hit (stable key)");
    });

    it("deduplicates concurrent computations while one projection is already in progress", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));

        const { computeMapProjection } = loadModule();
        const firstPromise = computeMapProjection();
        const secondPromise = computeMapProjection();

        await flushMicrotasks();

        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(workers).toHaveLength(1);
        expect(mockUmapLoggerInfo).toHaveBeenCalledWith("[VIBE-MAP] Waiting for in-progress computation");

        workers[0].emit("message", [
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
            [4, 4],
        ]);

        const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

        expect(firstResult).toEqual(secondResult);
        expect(firstResult.trackCount).toBe(5);
    });

    it("returns an empty projection when no embedded tracks exist", async () => {
        const { computeMapProjection } = loadModule();

        const result = await computeMapProjection();

        expect(result).toEqual({
            tracks: [],
            trackCount: 0,
            computedAt: expect.any(String),
        });
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockRedisMulti).not.toHaveBeenCalled();
        expect(mockParseEmbedding).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
    });

    it("uses the circular fallback layout for datasets smaller than five tracks", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            makeRow(1, { moodElectronic: 0.95, moodParty: 0.3 }),
            makeRow(2, {
                moodHappy: null,
                moodSad: null,
                moodRelaxed: null,
                moodAggressive: null,
                moodParty: null,
                moodAcoustic: null,
                moodElectronic: null,
            }),
            makeRow(3, { moodRelaxed: 0.92, moodElectronic: 0.2 }),
            makeRow(4, { moodAggressive: 0.88, moodElectronic: 0.1 }),
        ]);

        const { computeMapProjection } = loadModule();
        const result = await computeMapProjection();

        expect(result.trackCount).toBe(4);
        expect(result.tracks).toEqual([
            expect.objectContaining({
                id: "track-1",
                x: expect.closeTo(0.8, 6),
                y: expect.closeTo(0.5, 6),
                dominantMood: "moodElectronic",
                moodScore: 0.95,
                moods: expect.objectContaining({ moodElectronic: 0.95 }),
            }),
            expect.objectContaining({
                id: "track-2",
                x: expect.closeTo(0.5, 6),
                y: expect.closeTo(0.8, 6),
                dominantMood: "neutral",
                moodScore: 0,
                moods: {},
            }),
            expect.objectContaining({
                id: "track-3",
                x: expect.closeTo(0.2, 6),
                y: expect.closeTo(0.5, 6),
                dominantMood: "moodRelaxed",
            }),
            expect.objectContaining({
                id: "track-4",
                x: expect.closeTo(0.5, 6),
                y: expect.closeTo(0.2, 6),
                dominantMood: "moodAggressive",
            }),
        ]);
        expect(mockParseEmbedding).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
        expect(pipeline.setEx).toHaveBeenCalledWith(
            "vibe:map:v3:projection",
            86400,
            expect.any(String)
        );
        expect(pipeline.del).toHaveBeenCalledWith("vibe:map:v3:track_ids");
        expect(pipeline.sAdd).toHaveBeenCalledWith("vibe:map:v3:track_ids", [
            "track-1",
            "track-2",
            "track-3",
            "track-4",
        ]);
        expect(pipeline.expire).toHaveBeenCalledWith("vibe:map:v3:track_ids", 86400);
        expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it("returns the projection even when Redis caching fails", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(4));
        pipeline.exec.mockImplementationOnce(async () => {
            throw new Error("redis down");
        });

        const { computeMapProjection } = loadModule();
        const result = await computeMapProjection();

        expect(result.trackCount).toBe(4);
        expect(mockUmapLoggerWarn).toHaveBeenCalledWith(
            "[VIBE-MAP] Failed to cache projection:",
            "redis down"
        );
    });

    it("runs the UMAP worker for larger datasets, normalizes coordinates, and caches the result", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            makeRow(1, { moodHappy: 0.9, moodElectronic: 0.4 }),
            makeRow(2, { moodSad: 0.8, moodElectronic: 0.1 }),
            makeRow(3, { moodRelaxed: 0.7, moodElectronic: 0.2 }),
            makeRow(4, { moodParty: 0.7, moodElectronic: 0.6 }),
            makeRow(5, { moodElectronic: 0.85, moodParty: 0.4 }),
        ]);
        workerBehavior = (worker) => {
            worker.emit("message", [
                [-3, 4],
                [1, 6],
                [0, 2],
                [5, 8],
                [3, 1],
            ]);
        };

        const { computeMapProjection } = loadModule();
        const result = await computeMapProjection();

        expect(result.trackCount).toBe(5);
        expect(result.tracks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "track-1",
                    x: 0,
                    y: expect.closeTo(3 / 7, 6),
                    dominantMood: "moodHappy",
                }),
                expect.objectContaining({
                    id: "track-4",
                    x: 1,
                    y: 1,
                    dominantMood: "moodParty",
                }),
                expect.objectContaining({
                    id: "track-5",
                    dominantMood: "moodElectronic",
                }),
            ])
        );
        expect(result.tracks.every((track) => track.x >= 0 && track.x <= 1 && track.y >= 0 && track.y <= 1)).toBe(true);
        expect(mockParseEmbedding).toHaveBeenCalledTimes(5);
        expect(lastWorkerFilename).toMatch(/umapWorker\.ts$/);
        expect(lastWorkerOptions).toEqual({
            workerData: {
                embeddings: [
                    [1, 2, 3],
                    [2, 3, 4],
                    [3, 4, 5],
                    [4, 5, 6],
                    [5, 6, 7],
                ],
                nNeighbors: 2,
            },
        });
        expect(pipeline.setEx).toHaveBeenCalledWith(
            "vibe:map:v3:projection",
            86400,
            expect.any(String)
        );
        expect(pipeline.expire).toHaveBeenCalledWith("vibe:map:v3:track_ids", 86400);
        expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it("times out the UMAP worker after fifteen minutes and terminates the worker", async () => {
        jest.useFakeTimers();
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));

        const { computeMapProjection } = loadModule();
        const projectionPromise = computeMapProjection();
        const rejection = expect(projectionPromise).rejects.toThrow("UMAP worker timed out after 15 minutes");

        await flushMicrotasks();
        expect(workers).toHaveLength(1);

        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(mockUmapLoggerWarn).toHaveBeenCalledWith(
            "[VIBE-MAP] UMAP worker running for 5+ minutes (5 tracks)"
        );

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

        await rejection;
        expect(workers[0].terminate).toHaveBeenCalledTimes(1);
        expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it("rejects when the worker posts an error payload", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));
        workerBehavior = (worker) => {
            worker.emit("message", { error: "projection failed" });
        };

        const { computeMapProjection } = loadModule();

        await expect(computeMapProjection()).rejects.toThrow("projection failed");
        expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it("rejects when the worker emits an error event", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));
        workerBehavior = (worker) => {
            worker.emit("error", new Error("worker exploded"));
        };

        const { computeMapProjection } = loadModule();

        await expect(computeMapProjection()).rejects.toThrow("worker exploded");
        expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it("rejects when the worker exits with a non-zero code", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));
        workerBehavior = (worker) => {
            worker.emit("exit", 2);
        };

        const { computeMapProjection } = loadModule();

        await expect(computeMapProjection()).rejects.toThrow("UMAP worker exited with code 2");
        expect(pipeline.exec).not.toHaveBeenCalled();
    });
});
