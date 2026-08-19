const get = jest.fn();
const setEx = jest.fn();
const del = jest.fn();
const evalScript = jest.fn();
const incr = jest.fn();
const record = jest.fn();
const warn = jest.fn();
jest.mock("../../../utils/redis", () => ({
    redisClient: { get, setEx, del, eval: evalScript, incr },
}));
jest.mock("../../../metrics", () => ({
    recordLibraryHealthCacheResult: record,
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn }) },
}));

import {
    getCachedLibraryHealthPanel,
    invalidateLibraryHealthDashboardCache,
    LIBRARY_HEALTH_CACHE_KEYS,
} from "../cache";

const summary = {
    metadataGaps: {
        missingArt: { albums: 1, artists: 2 },
        missingMbid: { albums: 3, artists: 4 },
        missingGenres: 5,
        missingLyrics: 6,
    },
    analysisCoverage: {
        total: 7,
        analysisStatus: { pending: 1, processing: 2, failed: 3, completed: 1 },
        vibeAnalysisStatus: {
            pending: 2,
            processing: 1,
            failed: 1,
            completed: 3,
        },
        loudness: { measured: 4, missing: 3 },
    },
    storage: {
        tracks: 7,
        totalFileSize: 1234,
        mimeTypes: 2,
        artists: 6,
        isTruncated: false,
    },
    quality: { floorKbps: 192, albumsBelowFloor: 1, isTruncated: false },
    duplicates: {
        clusters: 1,
        byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
        isTruncated: false,
    },
};
const storage = {
    formats: [
        {
            mime: "audio/mpeg",
            trackCount: 2,
            totalFileSize: 4000,
            averageBitrateKbps: 160,
            bitrateSampleSize: 2,
        },
    ],
    topArtists: [
        {
            artistId: "artist-1",
            artistName: "Artist",
            trackCount: 2,
            totalFileSize: 4000,
        },
    ],
    sampledTracks: 2,
    sampleLimit: 100_000,
    isTruncated: false,
};
const quality = {
    albums: [
        {
            albumId: "album-1",
            title: "Album",
            artist: { id: "artist-1", name: "Artist" },
            averageBitrateKbps: 160,
            trackCount: 2,
        },
    ],
    sampledTracks: 2,
    sampleLimit: 100_000,
    isTruncated: false,
};
const duplicates = {
    clusters: [
        {
            tier: "audioHash",
            identity: "hash",
            memberCount: 2,
            totalFileSize: 4000,
            members: [
                {
                    id: "track-1",
                    title: "Track",
                    albumTitle: "Album",
                    artistName: "Artist",
                    filePath: "/music/track.mp3",
                    fileSize: 2000,
                    mime: "audio/mpeg",
                },
                {
                    id: "track-2",
                    title: "Track Copy",
                    albumTitle: "Album",
                    artistName: "Artist",
                    filePath: "/music/track-copy.mp3",
                    fileSize: 2000,
                    mime: "audio/mpeg",
                },
            ],
        },
    ],
    total: 1,
    byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
    isTruncated: false,
};

const validPanels = { summary, storage, quality, duplicates } as const;
const cacheEnvelope = (payload: unknown, generation = "0") =>
    JSON.stringify({ generation, payload });

describe("library health cache", () => {
    let generation: number;
    let atomicWrites: Array<{ key: string; value: string }>;

    beforeEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
        get.mockReset();
        setEx.mockReset();
        del.mockReset();
        evalScript.mockReset();
        incr.mockReset();
        generation = 0;
        atomicWrites = [];
        get.mockImplementation(async (key: string) =>
            key === "library-health:v2:generation" ? String(generation) : null,
        );
        setEx.mockResolvedValue("OK");
        del.mockResolvedValue(1);
        incr.mockImplementation(async () => {
            generation += 1;
            return generation;
        });
        evalScript.mockImplementation(
            async (
                _script: string,
                options: { keys: string[]; arguments: string[] },
            ) => {
                if (options.arguments[0] !== String(generation)) return 0;
                atomicWrites.push({
                    key: options.keys[1],
                    value: options.arguments[2],
                });
                return 1;
            },
        );
    });

    afterEach(() => jest.useRealTimers());

    it.each(Object.entries(validPanels))(
        "round-trips a valid %s payload",
        async (panel, payload) => {
            get.mockResolvedValueOnce(cacheEnvelope(payload));
            const loader = jest.fn();

            await expect(
                getCachedLibraryHealthPanel(
                    panel as keyof typeof validPanels,
                    loader,
                ),
            ).resolves.toEqual(payload);
            expect(loader).not.toHaveBeenCalled();
            expect(record).toHaveBeenCalledWith(panel, "hit");
        },
    );

    it.each(Object.entries(validPanels))(
        "discards and recomputes an invalid %s payload",
        async (panel, payload) => {
            get.mockResolvedValueOnce("{}");
            const loader = jest.fn(async () => payload);

            await expect(
                getCachedLibraryHealthPanel(
                    panel as keyof typeof validPanels,
                    loader,
                ),
            ).resolves.toEqual(payload);
            expect(del).toHaveBeenCalledWith(
                LIBRARY_HEALTH_CACHE_KEYS[panel as keyof typeof validPanels],
            );
            expect(loader).toHaveBeenCalledTimes(1);
            expect(record).toHaveBeenCalledWith(panel, "error");
        },
    );

    it("coalesces misses and caches for fifteen minutes", async () => {
        const loader = jest.fn(async () => storage);

        const results = await Promise.all([
            getCachedLibraryHealthPanel("storage", loader),
            getCachedLibraryHealthPanel("storage", loader),
        ]);

        expect(results).toEqual([storage, storage]);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(atomicWrites).toEqual([
            {
                key: LIBRARY_HEALTH_CACHE_KEYS.storage,
                value: cacheEnvelope(storage),
            },
        ]);
        expect(evalScript).toHaveBeenCalledWith(expect.any(String), {
            keys: [
                "library-health:v2:generation",
                LIBRARY_HEALTH_CACHE_KEYS.storage,
            ],
            arguments: ["0", "900", cacheEnvelope(storage)],
        });
    });

    it("treats a hung read as a miss and releases the single-flight entry", async () => {
        jest.useFakeTimers();
        get.mockReturnValueOnce(new Promise(() => undefined));
        const loader = jest.fn(async () => storage);

        const first = getCachedLibraryHealthPanel("storage", loader);
        await jest.advanceTimersByTimeAsync(1_500);
        await expect(first).resolves.toEqual(storage);

        await expect(
            getCachedLibraryHealthPanel("storage", loader),
        ).resolves.toEqual(storage);
        expect(loader).toHaveBeenCalledTimes(2);
        expect(record).toHaveBeenCalledWith("storage", "error");
    });

    it("returns a loaded value without waiting for a hung cache write", async () => {
        jest.useFakeTimers();
        evalScript.mockReturnValueOnce(new Promise(() => undefined));

        await expect(
            getCachedLibraryHealthPanel("quality", async () => quality),
        ).resolves.toEqual(quality);

        await jest.advanceTimersByTimeAsync(1_500);
        expect(warn).toHaveBeenCalled();
    });

    it("bounds a hung cache invalidation", async () => {
        jest.useFakeTimers();
        del.mockReturnValueOnce(new Promise(() => undefined));

        const invalidation = invalidateLibraryHealthDashboardCache();
        await jest.advanceTimersByTimeAsync(1_500);

        await expect(invalidation).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it("recomputes after DEL fails following a successful generation advance", async () => {
        let cachedValue: string | null = null;
        const refreshedStorage = {
            ...storage,
            sampledTracks: 3,
        };
        get.mockImplementation(async (key: string) =>
            key === "library-health:v2:generation"
                ? String(generation)
                : cachedValue,
        );
        evalScript.mockImplementation(
            async (
                _script: string,
                options: { keys: string[]; arguments: string[] },
            ) => {
                if (options.arguments[0] !== String(generation)) return 0;
                cachedValue = options.arguments[2];
                return 1;
            },
        );
        const loader = jest
            .fn()
            .mockResolvedValueOnce(storage)
            .mockResolvedValueOnce(refreshedStorage);

        await expect(
            getCachedLibraryHealthPanel("storage", loader),
        ).resolves.toEqual(storage);
        del.mockRejectedValueOnce(new Error("delete unavailable"));
        await invalidateLibraryHealthDashboardCache();

        await expect(
            getCachedLibraryHealthPanel("storage", loader),
        ).resolves.toEqual(refreshedStorage);
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it("recomputes instead of serving a cache entry when generation verification fails", async () => {
        const refreshedStorage = {
            ...storage,
            sampledTracks: 3,
        };
        get.mockImplementation(async (key: string) => {
            if (key === "library-health:v2:generation") {
                throw new Error("generation unavailable");
            }
            return cacheEnvelope(storage);
        });
        const loader = jest.fn(async () => refreshedStorage);

        await expect(
            getCachedLibraryHealthPanel("storage", loader),
        ).resolves.toEqual(refreshedStorage);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith("storage", "error");
    });

    it("suppresses a stale fill after another replica bumps the generation", async () => {
        let releaseLoader!: (value: typeof duplicates) => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const blocked = new Promise<typeof duplicates>((resolve) => {
            releaseLoader = resolve;
        });
        const loader = jest
            .fn()
            .mockImplementationOnce(() => {
                markStarted();
                return blocked;
            })
            .mockResolvedValue(duplicates);

        const staleFill = getCachedLibraryHealthPanel("duplicates", loader);
        await started;
        generation += 1;
        releaseLoader(duplicates);

        await expect(staleFill).resolves.toEqual(duplicates);
        expect(evalScript).toHaveBeenCalledTimes(1);
        expect(atomicWrites).toEqual([]);

        await expect(
            getCachedLibraryHealthPanel("duplicates", loader),
        ).resolves.toEqual(duplicates);
        expect(loader).toHaveBeenCalledTimes(2);
        expect(atomicWrites).toEqual([
            {
                key: LIBRARY_HEALTH_CACHE_KEYS.duplicates,
                value: cacheEnvelope(duplicates, "1"),
            },
        ]);
    });

    it("aborts invalidation when the generation fence cannot advance", async () => {
        let releaseLoader!: (value: typeof duplicates) => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const blocked = new Promise<typeof duplicates>((resolve) => {
            releaseLoader = resolve;
        });
        const staleFill = getCachedLibraryHealthPanel("duplicates", () => {
            markStarted();
            return blocked;
        });
        await started;
        incr.mockRejectedValueOnce(new Error("generation unavailable"));

        await expect(invalidateLibraryHealthDashboardCache()).rejects.toThrow(
            "generation unavailable",
        );
        expect(del).not.toHaveBeenCalled();

        await invalidateLibraryHealthDashboardCache();
        releaseLoader(duplicates);
        await expect(staleFill).resolves.toEqual(duplicates);
        await Promise.resolve();

        expect(generation).toBe(1);
        expect(del).toHaveBeenCalledTimes(1);
        expect(atomicWrites).toEqual([]);
    });

    it("skips a cache write when the Redis generation read fails", async () => {
        get.mockImplementationOnce(async () => null).mockRejectedValueOnce(
            new Error("generation unavailable"),
        );

        await expect(
            getCachedLibraryHealthPanel("quality", async () => quality),
        ).resolves.toEqual(quality);

        expect(evalScript).not.toHaveBeenCalled();
        expect(atomicWrites).toEqual([]);
        expect(record).toHaveBeenCalledWith("quality", "error");
    });

    it("fails open on Redis errors and explicitly deletes known keys", async () => {
        get.mockRejectedValueOnce(new Error("offline"));
        get.mockRejectedValueOnce(new Error("offline"));

        await expect(
            getCachedLibraryHealthPanel("quality", async () => quality),
        ).resolves.toEqual(quality);
        expect(record).toHaveBeenCalledWith("quality", "error");
        expect(warn).toHaveBeenCalled();

        await invalidateLibraryHealthDashboardCache();
        expect(incr).toHaveBeenCalledWith("library-health:v2:generation");
        expect(del).toHaveBeenCalledWith(
            Object.values(LIBRARY_HEALTH_CACHE_KEYS),
        );
    });

    it.each([
        [
            "a zero member count",
            {
                ...duplicates,
                clusters: [{ ...duplicates.clusters[0], memberCount: 0 }],
            },
        ],
        [
            "an empty member preview",
            {
                ...duplicates,
                clusters: [{ ...duplicates.clusters[0], members: [] }],
            },
        ],
        [
            "a preview larger than its member count",
            {
                ...duplicates,
                clusters: [
                    {
                        ...duplicates.clusters[0],
                        memberCount: 2,
                        members: [
                            duplicates.clusters[0].members[0],
                            {
                                ...duplicates.clusters[0].members[0],
                                id: "track-2",
                            },
                            {
                                ...duplicates.clusters[0].members[0],
                                id: "track-3",
                            },
                        ],
                    },
                ],
            },
        ],
        [
            "a preview shorter than the disclosed member count",
            {
                ...duplicates,
                clusters: [
                    {
                        ...duplicates.clusters[0],
                        members: [duplicates.clusters[0].members[0]],
                    },
                ],
            },
        ],
        ["a mismatched total", { ...duplicates, total: 2 }],
        [
            "tier counts that do not sum to the total",
            {
                ...duplicates,
                byTier: { audioHash: 0, recordingMbid: 0, isrc: 0 },
            },
        ],
        [
            "tier counts assigned to the wrong cluster tier",
            {
                ...duplicates,
                byTier: { audioHash: 0, recordingMbid: 1, isrc: 0 },
            },
        ],
    ])("recomputes a duplicate catalog with %s", async (_name, payload) => {
        get.mockResolvedValueOnce(cacheEnvelope(payload));
        const loader = jest.fn(async () => duplicates);

        await expect(
            getCachedLibraryHealthPanel("duplicates", loader),
        ).resolves.toEqual(duplicates);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith(LIBRARY_HEALTH_CACHE_KEYS.duplicates);
    });
});
