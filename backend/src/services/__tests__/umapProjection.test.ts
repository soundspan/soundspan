const mockQueryRaw = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisMulti = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

type MockPipeline = {
    setEx: jest.Mock;
    del: jest.Mock;
    sAdd: jest.Mock;
    expire: jest.Mock;
    exec: jest.Mock;
};

let pipeline: MockPipeline;
let workerBehavior: ((worker: MockWorker) => void) | null = null;

class MockWorker {
    listeners = new Map<string, (payload?: unknown) => void>();
    terminate = jest.fn();

    constructor(_filename: string, _options: unknown) {
        setImmediate(() => {
            workerBehavior?.(this);
        });
    }

    on(event: string, listener: (payload?: unknown) => void): this {
        this.listeners.set(event, listener);
        return this;
    }

    emit(event: string, payload?: unknown): void {
        this.listeners.get(event)?.(payload);
    }
}

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
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        info: (...args: unknown[]) => mockLoggerInfo(...args),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

jest.mock("worker_threads", () => ({
    Worker: MockWorker,
}));

describe("computeMapProjection", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        workerBehavior = null;

        pipeline = {
            setEx: jest.fn().mockReturnThis(),
            del: jest.fn().mockReturnThis(),
            sAdd: jest.fn().mockReturnThis(),
            expire: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue([]),
        };

        mockRedisGet.mockResolvedValue(null);
        mockRedisMulti.mockReturnValue(pipeline);
        mockQueryRaw.mockResolvedValue([]);
    });

    it("returns cached projection data without querying the database", async () => {
        const cached = {
            tracks: [{ id: "track-1", x: 0.1, y: 0.2 }],
            trackCount: 1,
            computedAt: "2026-03-14T12:00:00.000Z",
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const { computeMapProjection } = require("../umapProjection") as typeof import("../umapProjection");
        await expect(computeMapProjection()).resolves.toEqual(cached);
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockRedisMulti).not.toHaveBeenCalled();
    });

    it("returns an empty projection when no embedded tracks exist", async () => {
        const { computeMapProjection } = require("../umapProjection") as typeof import("../umapProjection");

        const result = await computeMapProjection();

        expect(result.trackCount).toBe(0);
        expect(result.tracks).toEqual([]);
        expect(typeof result.computedAt).toBe("string");
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("computes, normalizes, and caches projection data for embedded tracks", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            {
                track_id: "track-1",
                title: "Track One",
                artistName: "Artist One",
                artistId: "artist-1",
                albumId: "album-1",
                coverUrl: null,
                energy: 0.8,
                valence: 0.7,
                moodHappy: 0.9,
                moodSad: 0.1,
                moodRelaxed: 0.3,
                moodAggressive: 0.2,
                moodParty: 0.6,
                moodAcoustic: 0.1,
                moodElectronic: 0.4,
                embedding: "[0.1,0.2,0.3]",
            },
            {
                track_id: "track-2",
                title: "Track Two",
                artistName: "Artist Two",
                artistId: "artist-2",
                albumId: "album-2",
                coverUrl: "cover-2.jpg",
                energy: 0.4,
                valence: 0.2,
                moodHappy: 0.2,
                moodSad: 0.8,
                moodRelaxed: 0.5,
                moodAggressive: 0.1,
                moodParty: 0.2,
                moodAcoustic: 0.7,
                moodElectronic: 0.1,
                embedding: "[0.4,0.5,0.6]",
            },
            {
                track_id: "track-3",
                title: "Track Three",
                artistName: "Artist Three",
                artistId: "artist-3",
                albumId: "album-3",
                coverUrl: null,
                energy: 0.6,
                valence: 0.5,
                moodHappy: 0.4,
                moodSad: 0.3,
                moodRelaxed: 0.7,
                moodAggressive: 0.2,
                moodParty: 0.3,
                moodAcoustic: 0.5,
                moodElectronic: 0.2,
                embedding: "[0.2,0.3,0.4]",
            },
            {
                track_id: "track-4",
                title: "Track Four",
                artistName: "Artist Four",
                artistId: "artist-4",
                albumId: "album-4",
                coverUrl: null,
                energy: 0.7,
                valence: 0.4,
                moodHappy: 0.6,
                moodSad: 0.2,
                moodRelaxed: 0.4,
                moodAggressive: 0.5,
                moodParty: 0.7,
                moodAcoustic: 0.2,
                moodElectronic: 0.6,
                embedding: "[0.6,0.4,0.2]",
            },
            {
                track_id: "track-5",
                title: "Track Five",
                artistName: "Artist Five",
                artistId: "artist-5",
                albumId: "album-5",
                coverUrl: null,
                energy: 0.3,
                valence: 0.9,
                moodHappy: 0.8,
                moodSad: 0.1,
                moodRelaxed: 0.6,
                moodAggressive: 0.1,
                moodParty: 0.4,
                moodAcoustic: 0.3,
                moodElectronic: 0.5,
                embedding: "[0.9,0.1,0.2]",
            },
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

        const { computeMapProjection } = require("../umapProjection") as typeof import("../umapProjection");
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
            ])
        );
        expect(pipeline.setEx).toHaveBeenCalledTimes(1);
        expect(pipeline.sAdd).toHaveBeenCalledWith(
            "vibe:map:v3:track_ids",
            ["track-1", "track-2", "track-3", "track-4", "track-5"]
        );
        expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });
});
