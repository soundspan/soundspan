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
const mockGetActiveSpace = jest.fn<() => Promise<{ id: string }>>();

let pipeline: MockPipeline;
let workerBehavior: ((worker: MockWorker, index: number) => void) | null = null;
let workers: MockWorker[] = [];
let lastWorkerFilename: string | null = null;
let lastWorkerOptions: {
    workerData?: { embeddings: number[][]; nNeighbors: number };
    resourceLimits?: { maxOldGenerationSizeMb?: number };
} | null = null;

class MockWorker {
    listeners = new Map<string, Array<(payload?: unknown) => void>>();
    terminate = jest.fn(async () => 0);

    constructor(
        filename: string,
        options: {
            workerData?: { embeddings: number[][]; nNeighbors: number };
            resourceLimits?: { maxOldGenerationSizeMb?: number };
        },
    ) {
        lastWorkerFilename = filename;
        lastWorkerOptions = options;
        workers.push(this);
        const index = workers.length - 1;

        setImmediate(() => {
            workerBehavior?.(this, index);
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

jest.mock("../../config", () => ({
    config: { vibeMapWorkerMemoryMb: 512 },
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

jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: () => mockGetActiveSpace(),
}));

jest.mock("worker_threads", () => ({
    Worker: MockWorker,
}));

const PROJECTION_KEY = "vibe:map:v5:projection:space-active";
const TRACK_IDS_KEY = "vibe:map:v5:track_ids:space-active";

function makeRow(index: number, overrides: Partial<QueryRow> = {}): QueryRow {
    return {
        track_id: `track-${index}`,
        title: `Track ${index}`,
        artistName: `Artist ${index}`,
        artistId: `artist-${index}`,
        albumId: `album-${index}`,
        coverUrl: index % 2 === 0 ? `cover-${index}.jpg` : null,
        loudnessLufs: null,
        truePeakDb: null,
        albumLoudnessLufs: null,
        albumTruePeakDb: null,
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

async function flushMicrotasks(turns = 8): Promise<void> {
    for (let index = 0; index < turns; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function cachedPayload(): { tracks: unknown[]; trackCount: number } {
    const setExCall = pipeline.setEx.mock.calls.find(
        (call) => call[0] === PROJECTION_KEY,
    );
    if (!setExCall) throw new Error("projection was never cached");
    return JSON.parse(setExCall[2] as string) as {
        tracks: unknown[];
        trackCount: number;
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

        workerBehavior = null;
        workers = [];
        lastWorkerFilename = null;
        lastWorkerOptions = null;

        pipeline = {
            setEx: jest.fn<(...args: unknown[]) => MockPipeline>(
                () => pipeline,
            ),
            del: jest.fn<(...args: unknown[]) => MockPipeline>(() => pipeline),
            sAdd: jest.fn<(...args: unknown[]) => MockPipeline>(() => pipeline),
            expire: jest.fn<(...args: unknown[]) => MockPipeline>(
                () => pipeline,
            ),
            exec: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
        };

        mockRedisGet.mockResolvedValue(null);
        mockRedisMulti.mockReturnValue(pipeline);
        mockQueryRaw.mockResolvedValue([]);
        mockExistsSync.mockImplementation((candidatePath: string) =>
            candidatePath.endsWith("umapWorker.ts"),
        );
        mockPathJoin.mockImplementation((...parts: string[]) =>
            parts.join("/").replace(/\/+/g, "/"),
        );
        mockParseEmbedding.mockImplementation(
            (embedding: string) => JSON.parse(embedding) as number[],
        );
        mockGetActiveSpace.mockResolvedValue({ id: "space-active" });
    });

    it("returns the cached projection for the active space without querying the database", async () => {
        const cached = {
            tracks: [{ id: "track-1", x: 0.1, y: 0.2 }],
            trackCount: 1,
            computedAt: "2026-03-14T12:00:00.000Z",
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const { computeMapProjection } = loadModule();

        await expect(computeMapProjection()).resolves.toEqual({
            status: "ready",
            data: cached,
        });
        expect(mockRedisGet).toHaveBeenCalledWith(PROJECTION_KEY);
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockRedisMulti).not.toHaveBeenCalled();
    });

    it("reports building and deduplicates concurrent background computations", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));

        const { computeMapProjection } = loadModule();
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });

        await flushMicrotasks();

        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        const [query, ...values] = mockQueryRaw.mock.calls[0];
        expect((query as readonly string[]).join(" ")).toContain(
            "te.space_id =",
        );
        expect(values).toContain("space-active");
        expect(workers).toHaveLength(1);

        workers[0].emit("message", [
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
            [4, 4],
        ]);
        await flushMicrotasks();

        expect(cachedPayload().trackCount).toBe(5);
    });

    it("caches an empty projection briefly when no embedded tracks exist", async () => {
        const { computeMapProjection } = loadModule();

        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockParseEmbedding).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
        expect(pipeline.setEx).toHaveBeenCalledWith(
            PROJECTION_KEY,
            300,
            expect.any(String),
        );
        expect(cachedPayload().trackCount).toBe(0);
    });

    it("uses the circular fallback layout for datasets smaller than five tracks", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            makeRow(1, {
                moodElectronic: 0.95,
                moodParty: 0.3,
                loudnessLufs: -17.6,
                truePeakDb: -1.4,
                albumLoudnessLufs: -18.2,
                albumTruePeakDb: -0.7,
            }),
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
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        const payload = cachedPayload();
        expect(payload.trackCount).toBe(4);
        expect(payload.tracks).toEqual([
            expect.objectContaining({
                id: "track-1",
                dominantMood: "moodElectronic",
                moodScore: 0.95,
                loudnessLufs: -17.6,
                truePeakDb: -1.4,
                albumLoudnessLufs: -18.2,
                albumTruePeakDb: -0.7,
            }),
            expect.objectContaining({
                id: "track-2",
                dominantMood: "neutral",
                moodScore: 0,
                moods: {},
                loudnessLufs: null,
                truePeakDb: null,
                albumLoudnessLufs: null,
                albumTruePeakDb: null,
            }),
            expect.objectContaining({
                id: "track-3",
                dominantMood: "moodRelaxed",
            }),
            expect.objectContaining({
                id: "track-4",
                dominantMood: "moodAggressive",
            }),
        ]);
        expect(mockParseEmbedding).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
        expect(pipeline.setEx).toHaveBeenCalledWith(
            PROJECTION_KEY,
            86400,
            expect.any(String),
        );
        expect(pipeline.del).toHaveBeenCalledWith(TRACK_IDS_KEY);
        expect(pipeline.sAdd).toHaveBeenCalledWith(TRACK_IDS_KEY, [
            "track-1",
            "track-2",
            "track-3",
            "track-4",
        ]);
        expect(pipeline.expire).toHaveBeenCalledWith(TRACK_IDS_KEY, 86400);
        expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it("runs the UMAP worker with a bounded heap, normalizes coordinates, and caches the result", async () => {
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
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        const payload = cachedPayload() as {
            trackCount: number;
            tracks: Array<{ id: string; x: number; y: number }>;
        };
        expect(payload.trackCount).toBe(5);
        expect(
            payload.tracks.every(
                (track) =>
                    track.x >= 0 &&
                    track.x <= 1 &&
                    track.y >= 0 &&
                    track.y <= 1,
            ),
        ).toBe(true);
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
            execArgv: ["--import", "tsx"],
            resourceLimits: { maxOldGenerationSizeMb: 512 },
        });
        expect(pipeline.setEx).toHaveBeenCalledWith(
            PROJECTION_KEY,
            86400,
            expect.any(String),
        );
        expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it("halves the sample and retries when the worker dies on its memory limit", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(4000));
        workerBehavior = (worker, index) => {
            if (index === 0) {
                const oom = new Error(
                    "Worker terminated due to reaching memory limit: JS heap out of memory",
                ) as NodeJS.ErrnoException;
                oom.code = "ERR_WORKER_OUT_OF_MEMORY";
                worker.emit("error", oom);
                return;
            }
            worker.emit(
                "message",
                Array.from({ length: 2000 }, (_, i) => [i, i]),
            );
        };

        const { computeMapProjection } = loadModule();
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks(16);

        expect(workers).toHaveLength(2);
        expect(lastWorkerOptions?.workerData?.embeddings).toHaveLength(2000);
        expect(mockUmapLoggerWarn).toHaveBeenCalledWith(
            expect.stringContaining("heap ceiling at 4000 tracks"),
        );
        const payload = cachedPayload() as {
            trackCount: number;
            sampled?: boolean;
        };
        expect(payload.trackCount).toBe(2000);
        expect(payload.sampled).toBe(true);
    });

    it("logs instead of caching when the worker posts an error payload", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));
        workerBehavior = (worker) => {
            worker.emit("message", { error: "projection failed" });
        };

        const { computeMapProjection } = loadModule();
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        expect(mockUmapLoggerError).toHaveBeenCalledWith(
            "Vibe map error:",
            expect.objectContaining({ message: "projection failed" }),
        );
        expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it("logs instead of caching when the worker exits with a non-zero code", async () => {
        mockQueryRaw.mockResolvedValueOnce(makeRows(5));
        workerBehavior = (worker) => {
            worker.emit("exit", 2);
        };

        const { computeMapProjection } = loadModule();
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        expect(mockUmapLoggerError).toHaveBeenCalledWith(
            "Vibe map error:",
            expect.objectContaining({
                message: "UMAP worker exited with code 2",
            }),
        );
        expect(pipeline.exec).not.toHaveBeenCalled();
    });

    it("allows a fresh build after a failed one", async () => {
        mockQueryRaw.mockResolvedValue(makeRows(5));
        workerBehavior = (worker, index) => {
            if (index === 0) {
                worker.emit("error", new Error("worker exploded"));
                return;
            }
            worker.emit("message", [
                [0, 0],
                [1, 1],
                [2, 2],
                [3, 3],
                [4, 4],
            ]);
        };

        const { computeMapProjection } = loadModule();
        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();
        expect(mockUmapLoggerError).toHaveBeenCalledTimes(1);

        await expect(computeMapProjection()).resolves.toEqual({
            status: "building",
        });
        await flushMicrotasks();

        expect(workers).toHaveLength(2);
        expect(cachedPayload().trackCount).toBe(5);
    });
});

describe("umapWorkerOptions", () => {
    it("registers tsx only for the development TypeScript worker", () => {
        const { umapWorkerOptions } = loadModule();
        const embeddings = [[1, 2, 3]];

        expect(
            umapWorkerOptions("/workers/umapWorker.ts", embeddings, 2),
        ).toEqual({
            workerData: { embeddings, nNeighbors: 2 },
            execArgv: ["--import", "tsx"],
        });
        expect(
            umapWorkerOptions("/workers/umapWorker.js", embeddings, 2),
        ).toEqual({
            workerData: { embeddings, nNeighbors: 2 },
        });
    });
});
