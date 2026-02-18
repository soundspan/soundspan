jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const prisma = {
    downloadJob: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const getSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings,
}));

const soulseekService = {
    isAvailable: jest.fn(),
    searchAndDownloadBatch: jest.fn(),
};
jest.mock("../soulseek", () => ({
    soulseekService,
}));

const simpleDownloadManager = {
    startDownload: jest.fn(),
};
jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager,
}));

const musicBrainzService = {
    getAlbumTracks: jest.fn(),
};
jest.mock("../musicbrainz", () => ({
    musicBrainzService,
}));

const lastFmService = {
    getArtistCorrection: jest.fn(),
    getAlbumInfo: jest.fn(),
};
jest.mock("../lastfm", () => ({
    lastFmService,
}));

class MockPQueue {
    concurrency: number;
    size: number;
    pending: number;

    constructor(options: { concurrency: number }) {
        this.concurrency = options.concurrency;
        this.size = 0;
        this.pending = 0;
    }

    async add<T>(fn: () => Promise<T>): Promise<T> {
        this.pending += 1;
        try {
            return await fn();
        } finally {
            this.pending -= 1;
        }
    }
}

jest.mock("p-queue", () => ({
    __esModule: true,
    default: MockPQueue,
}));

import { acquisitionService } from "../acquisitionService";

describe("acquisitionService", () => {
    const svc = acquisitionService as any;

    beforeEach(() => {
        jest.clearAllMocks();

        svc.lastConcurrency = 4;

        getSystemSettings.mockResolvedValue({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
        });

        soulseekService.isAvailable.mockResolvedValue(true);
        soulseekService.searchAndDownloadBatch.mockResolvedValue({
            successful: 2,
            errors: [],
        });

        musicBrainzService.getAlbumTracks.mockResolvedValue([
            { title: "Track A", position: 1 },
            { title: "Track B", position: 2 },
        ]);

        simpleDownloadManager.startDownload.mockResolvedValue({
            success: true,
            correlationId: "corr-1",
        });

        lastFmService.getArtistCorrection.mockResolvedValue(null);
        lastFmService.getAlbumInfo.mockResolvedValue(null);

        prisma.downloadJob.findUnique.mockResolvedValue({ metadata: {} });
        prisma.downloadJob.update.mockResolvedValue({});
        prisma.downloadJob.create.mockResolvedValue({ id: "101", metadata: {} });
    });

    it("computes behavior matrix for no sources, single-source, and dual-source cases", async () => {
        getSystemSettings.mockResolvedValueOnce({
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
        });
        soulseekService.isAvailable.mockResolvedValueOnce(false);
        await expect(svc.getDownloadBehavior()).resolves.toEqual({
            hasPrimarySource: false,
            primarySource: null,
            hasFallbackSource: false,
            fallbackSource: null,
        });

        getSystemSettings.mockResolvedValueOnce({
            downloadSource: "lidarr",
            primaryFailureFallback: "none",
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
        });
        soulseekService.isAvailable.mockResolvedValueOnce(true);
        await expect(svc.getDownloadBehavior()).resolves.toEqual({
            hasPrimarySource: true,
            primarySource: "soulseek",
            hasFallbackSource: false,
            fallbackSource: null,
        });

        getSystemSettings.mockResolvedValueOnce({
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        soulseekService.isAvailable.mockResolvedValueOnce(false);
        await expect(svc.getDownloadBehavior()).resolves.toEqual({
            hasPrimarySource: true,
            primarySource: "lidarr",
            hasFallbackSource: false,
            fallbackSource: null,
        });

        getSystemSettings.mockResolvedValueOnce({
            downloadSource: "lidarr",
            primaryFailureFallback: undefined,
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        soulseekService.isAvailable.mockResolvedValueOnce(true);
        await expect(svc.getDownloadBehavior()).resolves.toEqual({
            hasPrimarySource: true,
            primarySource: "lidarr",
            hasFallbackSource: true,
            fallbackSource: "soulseek",
        });

        getSystemSettings.mockResolvedValueOnce({
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        soulseekService.isAvailable.mockResolvedValueOnce(true);
        await expect(svc.getDownloadBehavior()).resolves.toEqual({
            hasPrimarySource: true,
            primarySource: "soulseek",
            hasFallbackSource: false,
            fallbackSource: null,
        });
    });

    it("updates queue concurrency when settings change", async () => {
        getSystemSettings.mockResolvedValueOnce({ soulseekConcurrentDownloads: 7 });

        await svc.updateQueueConcurrency();

        expect(svc.lastConcurrency).toBe(7);
        expect(svc.albumQueue.concurrency).toBe(7);
    });

    it("acquires tracks and handles unavailable, missing path, success, and batch exceptions", async () => {
        soulseekService.isAvailable.mockResolvedValueOnce(false);
        const unavailableResults = await svc.acquireTracks(
            [{ artistName: "A", trackTitle: "T" }],
            { userId: "user-1" }
        );
        expect(unavailableResults).toEqual([
            {
                success: false,
                error: "Soulseek not configured",
            },
        ]);

        soulseekService.isAvailable.mockResolvedValueOnce(true);
        getSystemSettings.mockResolvedValueOnce({ musicPath: "" });
        const missingPathResults = await svc.acquireTracks(
            [{ artistName: "A", trackTitle: "T" }],
            { userId: "user-1" }
        );
        expect(missingPathResults).toEqual([
            {
                success: false,
                error: "Music path not configured",
            },
        ]);

        soulseekService.isAvailable.mockResolvedValueOnce(true);
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
        });
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 1,
            errors: ["Artist B - Track B: not found"],
        });
        const successResults = await svc.acquireTracks(
            [
                { artistName: "Artist A", trackTitle: "Track A" },
                { artistName: "Artist B", trackTitle: "Track B" },
            ],
            { userId: "user-1" }
        );
        expect(successResults).toEqual([
            {
                success: true,
                source: "soulseek",
                tracksDownloaded: 1,
                tracksTotal: 1,
                error: undefined,
            },
            {
                success: false,
                source: "soulseek",
                tracksDownloaded: 0,
                tracksTotal: 1,
                error: "Artist B - Track B: not found",
            },
        ]);

        soulseekService.isAvailable.mockResolvedValueOnce(true);
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
        });
        soulseekService.searchAndDownloadBatch.mockRejectedValueOnce(
            new Error("batch failed")
        );
        const errorResults = await svc.acquireTracks(
            [{ artistName: "Artist A", trackTitle: "Track A" }],
            { userId: "user-1" }
        );
        expect(errorResults).toEqual([
            {
                success: false,
                error: "batch failed",
            },
        ]);
    });

    it("creates jobs with context metadata and validates invalid user IDs", async () => {
        await expect(
            svc.createDownloadJob(
                {
                    artistName: "Artist",
                    albumTitle: "Album",
                    mbid: "rg-1",
                },
                { existingJobId: "existing-1", userId: "user-1" }
            )
        ).resolves.toEqual({ id: "existing-1" });
        expect(prisma.downloadJob.create).not.toHaveBeenCalled();

        await expect(
            svc.createDownloadJob(
                {
                    artistName: "Artist",
                    albumTitle: "Album",
                    mbid: "rg-1",
                },
                { userId: "NaN" }
            )
        ).rejects.toThrow("Invalid userId");

        prisma.downloadJob.create.mockResolvedValueOnce({ id: "202" });
        await expect(
            svc.createDownloadJob(
                {
                    artistName: "Artist",
                    albumTitle: "Album",
                    mbid: "rg-2",
                },
                {
                    userId: "user-2",
                    discoveryBatchId: "batch-1",
                    spotifyImportJobId: "import-1",
                }
            )
        ).resolves.toEqual({ id: "202" });

        expect(prisma.downloadJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "user-2",
                discoveryBatchId: "batch-1",
                metadata: expect.objectContaining({
                    artistName: "Artist",
                    albumTitle: "Album",
                    albumMbid: "rg-2",
                    downloadType: "spotify_import",
                    spotifyImportJobId: "import-1",
                }),
            }),
        });
    });

    it("updates job status text and terminal statuses", async () => {
        prisma.downloadJob.findUnique.mockResolvedValueOnce({
            metadata: { lidarrAttempts: 1 },
        });

        await svc.updateJobStatusText("101", "soulseek", 2);

        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "101" },
            data: {
                metadata: {
                    lidarrAttempts: 1,
                    currentSource: "soulseek",
                    soulseekAttempts: 2,
                    statusText: "Soulseek #2",
                },
            },
        });

        await svc.updateJobStatus("101", "failed", "oops");
        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "101" },
            data: {
                status: "failed",
                error: "oops",
                completedAt: expect.any(Date),
            },
        });
    });

    it("routes primary/fallback logic in acquireAlbum", async () => {
        jest.spyOn(svc, "updateQueueConcurrency").mockResolvedValue(undefined);
        jest.spyOn(svc, "getDownloadBehavior")
            .mockResolvedValueOnce({
                hasPrimarySource: false,
                primarySource: null,
                hasFallbackSource: false,
                fallbackSource: null,
            })
            .mockResolvedValueOnce({
                hasPrimarySource: true,
                primarySource: "soulseek",
                hasFallbackSource: false,
                fallbackSource: null,
            })
            .mockResolvedValueOnce({
                hasPrimarySource: true,
                primarySource: "soulseek",
                hasFallbackSource: true,
                fallbackSource: "lidarr",
            })
            .mockResolvedValueOnce({
                hasPrimarySource: true,
                primarySource: "lidarr",
                hasFallbackSource: true,
                fallbackSource: "soulseek",
            });

        jest.spyOn(svc, "acquireAlbumViaSoulseek")
            .mockResolvedValueOnce({ success: true, source: "soulseek" })
            .mockResolvedValueOnce({ success: false, error: "failed primary" })
            .mockResolvedValueOnce({ success: true, source: "soulseek" });
        jest.spyOn(svc, "acquireAlbumViaLidarr")
            .mockResolvedValueOnce({ success: true, source: "lidarr" })
            .mockResolvedValueOnce({ success: false, error: "lidarr failed" });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            error: "No download sources available (neither Soulseek nor Lidarr configured)",
        });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({ success: true, source: "soulseek" });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({ success: true, source: "lidarr" });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({ success: true, source: "soulseek" });
    });

    it("acquireAlbumViaSoulseek handles missing settings, missing mbid, and requested-track success", async () => {
        getSystemSettings.mockResolvedValueOnce({ musicPath: "" });
        await expect(
            svc.acquireAlbumViaSoulseek(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({ success: false, error: "Music path not configured" });

        getSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        await expect(
            svc.acquireAlbumViaSoulseek(
                { artistName: "Artist", albumTitle: "Album" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            error: "Album MBID required for Soulseek download",
        });

        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 3,
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "303",
            metadata: { soulseekAttempts: 1 },
        });
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 2,
            errors: [],
        });

        const result = await svc.acquireAlbumViaSoulseek(
            {
                artistName: "Artist",
                albumTitle: "Album",
                mbid: "rg-3",
                requestedTracks: [{ title: "Only Track" }, { title: "Two" }],
            },
            { userId: "user-1" }
        );

        expect(result).toEqual({
            success: true,
            source: "soulseek",
            downloadJobId: 303,
            tracksDownloaded: 2,
            tracksTotal: 2,
            error: undefined,
        });
        expect(soulseekService.searchAndDownloadBatch).toHaveBeenCalledWith(
            [
                { artist: "Artist", title: "Only Track", album: "Album" },
                { artist: "Artist", title: "Two", album: "Album" },
            ],
            "/music",
            3
        );
    });

    it("acquireAlbumViaSoulseek uses MusicBrainz/Last.fm fallback and handles empty or partial failures", async () => {
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
        });
        prisma.downloadJob.create.mockResolvedValueOnce({ id: "401", metadata: {} });
        musicBrainzService.getAlbumTracks.mockResolvedValueOnce([]);
        lastFmService.getAlbumInfo.mockResolvedValueOnce({
            tracks: {
                track: [{ name: "LFM Track", "@attr": { rank: "1" } }],
            },
        });
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 0,
            errors: ["Artist - LFM Track: missing"],
        });

        await expect(
            svc.acquireAlbumViaSoulseek(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-4" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            tracksTotal: 1,
            downloadJobId: 401,
            error: "No tracks found on Soulseek (searched 1 tracks)",
        });

        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
        });
        prisma.downloadJob.create.mockResolvedValueOnce({ id: "402", metadata: {} });
        musicBrainzService.getAlbumTracks.mockResolvedValueOnce([
            { title: "Track 1" },
            { title: "Track 2" },
            { title: "Track 3" },
            { title: "Track 4" },
        ]);
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 1,
            errors: ["x"],
        });

        const partialResult = await svc.acquireAlbumViaSoulseek(
            { artistName: "Artist", albumTitle: "Album", mbid: "rg-5" },
            { userId: "user-1" }
        );
        expect(partialResult).toEqual({
            success: false,
            source: "soulseek",
            downloadJobId: 402,
            tracksDownloaded: 1,
            tracksTotal: 4,
            error: "Only 1/4 tracks found",
        });

        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
        });
        prisma.downloadJob.create.mockResolvedValueOnce({ id: "403", metadata: {} });
        musicBrainzService.getAlbumTracks.mockResolvedValueOnce([]);
        lastFmService.getAlbumInfo.mockResolvedValueOnce({ tracks: { track: [] } });

        await expect(
            svc.acquireAlbumViaSoulseek(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-6" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            error: "Could not get track list from MusicBrainz or Last.fm",
        });
    });

    it("acquireAlbumViaSoulseek handles thrown errors and job-status update failures", async () => {
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
        });
        prisma.downloadJob.create.mockResolvedValueOnce({ id: "501", metadata: {} });
        prisma.downloadJob.update
            .mockRejectedValueOnce(new Error("status write failed"))
            .mockResolvedValue({});

        const result = await svc.acquireAlbumViaSoulseek(
            { artistName: "Artist", albumTitle: "Album", mbid: "rg-7" },
            { userId: "user-1" }
        );

        expect(result).toEqual({ success: false, error: "status write failed" });
    });

    it("acquireAlbumViaLidarr handles missing mbid, success, structured failure, and exception", async () => {
        await expect(
            svc.acquireAlbumViaLidarr(
                { artistName: "Artist", albumTitle: "Album" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            error: "Album MBID required for Lidarr download",
        });

        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "601",
            metadata: { lidarrAttempts: 0 },
        });
        simpleDownloadManager.startDownload.mockResolvedValueOnce({
            success: true,
            correlationId: "corr-601",
        });

        await expect(
            svc.acquireAlbumViaLidarr(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-8" },
                { userId: "user-1", discoveryBatchId: "batch-1" }
            )
        ).resolves.toEqual({
            success: true,
            source: "lidarr",
            downloadJobId: 601,
            correlationId: "corr-601",
        });

        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "602",
            metadata: { lidarrAttempts: 1 },
        });
        simpleDownloadManager.startDownload.mockResolvedValueOnce({
            success: false,
            error: "indexer unavailable",
            errorType: "network",
            isRecoverable: true,
        });

        await expect(
            svc.acquireAlbumViaLidarr(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-9" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            error: "indexer unavailable",
            errorType: "network",
            isRecoverable: true,
        });

        prisma.downloadJob.create.mockRejectedValueOnce(new Error("db explode"));
        await expect(
            svc.acquireAlbumViaLidarr(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-10" },
                { userId: "user-1" }
            )
        ).resolves.toEqual({
            success: false,
            error: "db explode",
        });
    });
});
