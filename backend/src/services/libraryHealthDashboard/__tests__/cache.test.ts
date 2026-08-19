const get = jest.fn();
const setEx = jest.fn();
const del = jest.fn();
const record = jest.fn();
const warn = jest.fn();
jest.mock("../../../utils/redis", () => ({ redisClient: { get, setEx, del } }));
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
            ],
        },
    ],
    total: 1,
    byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
    isTruncated: false,
};

const validPanels = { summary, storage, quality, duplicates } as const;

describe("library health cache", () => {
    beforeEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
        get.mockResolvedValue(null);
        setEx.mockResolvedValue("OK");
        del.mockResolvedValue(1);
    });

    afterEach(() => jest.useRealTimers());

    it.each(Object.entries(validPanels))(
        "round-trips a valid %s payload",
        async (panel, payload) => {
            get.mockResolvedValueOnce(JSON.stringify(payload));
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
        expect(setEx).toHaveBeenCalledWith(
            LIBRARY_HEALTH_CACHE_KEYS.storage,
            900,
            JSON.stringify(storage),
        );
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
        setEx.mockReturnValueOnce(new Promise(() => undefined));

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

    it("suppresses stale fill writes and recomputes after invalidation", async () => {
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
        const invalidation = invalidateLibraryHealthDashboardCache();
        releaseLoader(duplicates);

        await expect(staleFill).resolves.toEqual(duplicates);
        await invalidation;
        expect(setEx).not.toHaveBeenCalled();

        await expect(
            getCachedLibraryHealthPanel("duplicates", loader),
        ).resolves.toEqual(duplicates);
        expect(loader).toHaveBeenCalledTimes(2);
        expect(setEx).toHaveBeenCalledTimes(1);
    });

    it("fails open on Redis errors and explicitly deletes known keys", async () => {
        get.mockRejectedValueOnce(new Error("offline"));
        setEx.mockRejectedValueOnce(new Error("offline"));

        await expect(
            getCachedLibraryHealthPanel("quality", async () => quality),
        ).resolves.toEqual(quality);
        expect(record).toHaveBeenCalledWith("quality", "error");
        expect(warn).toHaveBeenCalled();

        await invalidateLibraryHealthDashboardCache();
        expect(del).toHaveBeenCalledWith(
            Object.values(LIBRARY_HEALTH_CACHE_KEYS),
        );
    });
});
