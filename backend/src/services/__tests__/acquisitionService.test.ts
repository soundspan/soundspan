jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
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

const probeDownloadSourceAvailability = jest.fn();
jest.mock("../downloadSourcePolicy", () => ({
    ...jest.requireActual("../downloadSourcePolicy"),
    probeDownloadSourceAvailability: (...args: unknown[]) =>
        probeDownloadSourceAvailability(...args),
}));

jest.mock("../lidarr", () => ({
    lidarrService: { isEnabled: jest.fn() },
}));

jest.mock("../tidal", () => ({
    tidalService: { isAvailable: jest.fn() },
}));

jest.mock("../youtubeDownload", () => ({
    youtubeDownloadService: { isAvailable: jest.fn() },
}));

const processSoulseekDownload = jest.fn();
jest.mock("../soulseekLibraryDownload", () => ({
    processSoulseekDownload: (...args: unknown[]) =>
        processSoulseekDownload(...args),
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
        probeDownloadSourceAvailability.mockResolvedValue({
            tidal: false,
            lidarr: false,
            soulseek: true,
            youtube: false,
        });
        processSoulseekDownload.mockResolvedValue({
            success: true,
            source: "soulseek",
            downloadJobId: 101,
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
        prisma.downloadJob.create.mockResolvedValue({
            id: "101",
            metadata: {},
        });
    });

    it("respects the shared policy when an unavailable primary is set to Skip", async () => {
        getSystemSettings.mockResolvedValue({
            downloadSource: "lidarr",
            primaryFailureFallback: "none",
        });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: false,
            error: "No download sources available (neither Soulseek nor Lidarr configured)",
        });

        expect(processSoulseekDownload).not.toHaveBeenCalled();
        expect(simpleDownloadManager.startDownload).not.toHaveBeenCalled();
    });

    it("updates queue concurrency when settings change", async () => {
        getSystemSettings.mockResolvedValueOnce({
            soulseekConcurrentDownloads: 7,
        });

        await svc.updateQueueConcurrency();

        expect(svc.lastConcurrency).toBe(7);
        expect(svc.albumQueue.concurrency).toBe(7);
    });

    it("acquires tracks and handles unavailable, missing path, success, and batch exceptions", async () => {
        soulseekService.isAvailable.mockResolvedValueOnce(false);
        const unavailableResults = await svc.acquireTracks(
            [{ artistName: "A", trackTitle: "T" }],
            { userId: "user-1" },
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
            { userId: "user-1" },
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
            { userId: "user-1" },
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
            new Error("batch failed"),
        );
        const errorResults = await svc.acquireTracks(
            [{ artistName: "Artist A", trackTitle: "Track A" }],
            { userId: "user-1" },
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
                { existingJobId: "existing-1", userId: "user-1" },
            ),
        ).resolves.toEqual({ id: "existing-1" });
        expect(prisma.downloadJob.create).not.toHaveBeenCalled();

        await expect(
            svc.createDownloadJob(
                {
                    artistName: "Artist",
                    albumTitle: "Album",
                    mbid: "rg-1",
                },
                { userId: "NaN" },
            ),
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
                },
            ),
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

    it("uses the shared policy for primary and runtime fallback routing", async () => {
        getSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "soulseek",
            primaryFailureFallback: "lidarr",
        });
        probeDownloadSourceAvailability.mockResolvedValue({
            tidal: true,
            lidarr: true,
            soulseek: true,
            youtube: true,
        });
        processSoulseekDownload.mockResolvedValueOnce({
            success: false,
            error: "failed primary",
        });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: true,
            source: "lidarr",
            downloadJobId: 101,
            correlationId: "corr-1",
        });

        expect(processSoulseekDownload).toHaveBeenCalledWith(
            "101",
            "Artist",
            "Album",
            "user-1",
        );
        expect(simpleDownloadManager.startDownload).toHaveBeenCalledTimes(1);
    });

    it("routes a failed Lidarr primary to the Soulseek fallback", async () => {
        getSystemSettings.mockResolvedValue({
            musicPath: "/music",
            soulseekConcurrentDownloads: 4,
            downloadSource: "lidarr",
            primaryFailureFallback: "soulseek",
        });
        probeDownloadSourceAvailability.mockResolvedValue({
            tidal: false,
            lidarr: true,
            soulseek: true,
            youtube: false,
        });
        simpleDownloadManager.startDownload.mockResolvedValueOnce({
            success: false,
            error: "Lidarr primary failed",
        });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: true,
            source: "soulseek",
            downloadJobId: 101,
        });

        expect(simpleDownloadManager.startDownload).toHaveBeenCalledTimes(1);
        expect(processSoulseekDownload).toHaveBeenCalledWith(
            "101",
            "Artist",
            "Album",
            "user-1",
        );
    });

    it("does not create a Soulseek job when the music path is missing", async () => {
        getSystemSettings.mockResolvedValue({
            musicPath: "",
            soulseekConcurrentDownloads: 4,
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
        });

        await expect(
            svc.acquireAlbum(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-1" },
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: false,
            error: "Music path not configured",
        });

        expect(prisma.downloadJob.create).not.toHaveBeenCalled();
        expect(processSoulseekDownload).not.toHaveBeenCalled();
    });

    it("delegates requested-track Soulseek albums to the moved processor", async () => {
        const requestedTracks = [{ title: "Only Track" }, { title: "Two" }];

        await expect(
            svc.acquireAlbum(
                {
                    artistName: "Artist",
                    albumTitle: "Album",
                    mbid: "rg-3",
                    requestedTracks,
                },
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: true,
            source: "soulseek",
            downloadJobId: 101,
        });

        expect(prisma.downloadJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                targetMbid: "rg-3",
                metadata: expect.objectContaining({ requestedTracks }),
            }),
        });
        expect(processSoulseekDownload).toHaveBeenCalledWith(
            "101",
            "Artist",
            "Album",
            "user-1",
        );
    });

    it("acquireAlbumViaLidarr handles missing mbid, success, structured failure, and exception", async () => {
        await expect(
            svc.acquireAlbumViaLidarr(
                { artistName: "Artist", albumTitle: "Album" },
                { userId: "user-1" },
            ),
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
                { userId: "user-1", discoveryBatchId: "batch-1" },
            ),
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
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: false,
            error: "indexer unavailable",
            errorType: "network",
            isRecoverable: true,
        });

        prisma.downloadJob.create.mockRejectedValueOnce(
            new Error("db explode"),
        );
        await expect(
            svc.acquireAlbumViaLidarr(
                { artistName: "Artist", albumTitle: "Album", mbid: "rg-10" },
                { userId: "user-1" },
            ),
        ).resolves.toEqual({
            success: false,
            error: "db explode",
        });
    });
});
