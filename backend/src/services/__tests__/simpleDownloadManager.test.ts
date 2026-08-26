import { simpleDownloadManager } from "../simpleDownloadManager";
import { prisma } from "../../utils/db";
import {
    lidarrService,
    AcquisitionError,
    AcquisitionErrorType,
} from "../lidarr";
import { musicBrainzService } from "../musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { notificationService } from "../notificationService";
import { notificationPolicyService } from "../notificationPolicyService";
import { discoverWeeklyService } from "../discoverWeekly";
import { spotifyImportService } from "../spotifyImport";

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

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music-default",
        },
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        userDiscoverConfig: {
            findUnique: jest.fn(),
        },
        downloadJob: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock("../lidarr", () => {
    class AcquisitionError extends Error {
        public readonly type: string;
        public readonly isRecoverable: boolean;
        constructor(message: string, type: string, isRecoverable = true) {
            super(message);
            this.name = "AcquisitionError";
            this.type = type;
            this.isRecoverable = isRecoverable;
        }
    }
    return {
        AcquisitionError,
        AcquisitionErrorType: {
            NO_RELEASES_AVAILABLE: "NO_RELEASES_AVAILABLE",
            ALBUM_NOT_FOUND: "ALBUM_NOT_FOUND",
            UNKNOWN: "UNKNOWN",
        },
        lidarrService: {
            addAlbum: jest.fn(),
            getArtistAlbums: jest.fn(),
            getReconciliationSnapshot: jest.fn(),
            isAlbumAvailableInSnapshot: jest.fn(),
            isDownloadActiveInSnapshot: jest.fn(),
            blocklistAndRemove: jest.fn(),
            clearFailedQueue: jest.fn(),
        },
    };
});

jest.mock("../../utils/async", () => ({
    yieldToEventLoop: jest.fn(async () => undefined),
    chunkArray: jest.fn((items: any[], size: number) => {
        const out: any[][] = [];
        for (let i = 0; i < items.length; i += size) {
            out.push(items.slice(i, i + size));
        }
        return out;
    }),
}));

jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroup: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../notificationService", () => ({
    notificationService: {
        notifyDownloadComplete: jest.fn(),
        notifyDownloadFailed: jest.fn(),
    },
}));

jest.mock("../notificationPolicyService", () => ({
    notificationPolicyService: {
        evaluateNotification: jest.fn(),
    },
}));

jest.mock("../../utils/playlistLogger", () => ({
    sessionLog: jest.fn(),
}));

jest.mock("../discoverWeekly", () => ({
    discoverWeeklyService: {
        checkBatchCompletion: jest.fn(),
    },
}));

jest.mock("../spotifyImport", () => ({
    spotifyImportService: {
        checkImportCompletion: jest.fn(),
    },
}));

const mockPrisma = prisma as any;
const mockLidarrService = lidarrService as jest.Mocked<typeof lidarrService>;
const mockMusicBrainzService = musicBrainzService as jest.Mocked<
    typeof musicBrainzService
>;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockNotificationService = notificationService as jest.Mocked<
    typeof notificationService
>;
const mockNotificationPolicyService = notificationPolicyService as jest.Mocked<
    typeof notificationPolicyService
>;
const mockDiscoverWeeklyService = discoverWeeklyService as jest.Mocked<
    typeof discoverWeeklyService
>;
const mockSpotifyImportService = spotifyImportService as jest.Mocked<
    typeof spotifyImportService
>;

function makeTx() {
    return {
        downloadJob: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
        },
    };
}

describe("simpleDownloadManager", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPrisma.$transaction.mockImplementation(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValue(null);
                tx.downloadJob.findMany.mockResolvedValue([]);
                tx.downloadJob.update.mockResolvedValue({});
                tx.downloadJob.updateMany.mockResolvedValue({ count: 0 });
                tx.downloadJob.create.mockResolvedValue({ id: "created-job" });
                return operation(tx);
            },
        );

        mockPrisma.userDiscoverConfig.findUnique.mockResolvedValue({
            userId: "user-1",
            maxRetryAttempts: 3,
        });
        mockPrisma.downloadJob.findUnique.mockResolvedValue({ metadata: {} });
        mockPrisma.downloadJob.findFirst.mockResolvedValue(null);
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.downloadJob.update.mockResolvedValue({});
        mockPrisma.downloadJob.updateMany.mockResolvedValue({ count: 0 });
        mockPrisma.downloadJob.create.mockResolvedValue({ id: "new-job" });
        mockPrisma.downloadJob.count.mockResolvedValue(0);

        mockLidarrService.addAlbum.mockResolvedValue({
            id: 77,
            foreignAlbumId: "album-mbid-1",
        } as any);
        mockLidarrService.getArtistAlbums.mockResolvedValue([]);
        mockLidarrService.blocklistAndRemove.mockResolvedValue(true);
        mockLidarrService.clearFailedQueue.mockResolvedValue({
            removed: 0,
            errors: [],
        });

        mockMusicBrainzService.getReleaseGroup.mockResolvedValue({
            "artist-credit": [{ artist: { id: "artist-mbid-1" } }],
        } as any);

        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            lidarrUrl: "http://lidarr:8686",
            lidarrApiKey: "api-key",
        });

        mockNotificationPolicyService.evaluateNotification.mockResolvedValue({
            shouldNotify: true,
            reason: "policy allows",
        } as any);
        mockNotificationService.notifyDownloadComplete.mockResolvedValue(
            undefined as any,
        );
        mockNotificationService.notifyDownloadFailed.mockResolvedValue(
            undefined as any,
        );
        mockDiscoverWeeklyService.checkBatchCompletion.mockResolvedValue(
            undefined as any,
        );
        mockSpotifyImportService.checkImportCompletion.mockResolvedValue(
            undefined as any,
        );
    });

    it("starts a download successfully and preserves existing metadata", async () => {
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            metadata: { tier: "primary", similarity: 0.87 },
        });

        const result = await simpleDownloadManager.startDownload(
            "job-1",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
        );

        expect(result.success).toBe(true);
        expect(result.correlationId).toBeDefined();
        expect(mockMusicBrainzService.getReleaseGroup).toHaveBeenCalledWith(
            "album-mbid-1",
        );
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-1",
            "Artist",
            "Album",
            "/music",
            "artist-mbid-1",
            false,
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: expect.objectContaining({
                    status: "processing",
                    metadata: expect.objectContaining({
                        tier: "primary",
                        similarity: 0.87,
                        artistName: "Artist",
                        albumTitle: "Album",
                        currentSource: "lidarr",
                    }),
                }),
            }),
        );
    });

    it("uses a supplied artist MBID without querying the release group", async () => {
        const result = await simpleDownloadManager.startDownload(
            "job-known-artist",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
            false,
            "artist-mbid-known",
        );

        expect(result.success).toBe(true);
        expect(mockMusicBrainzService.getReleaseGroup).not.toHaveBeenCalled();
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-1",
            "Artist",
            "Album",
            "/music",
            "artist-mbid-known",
            false,
        );
    });

    it("fails discovery download with no sources and triggers batch completion check", async () => {
        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("No releases available"),
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-disc-1",
            discoveryBatchId: "batch-1",
            metadata: { artistMbid: "artist-mbid-1" },
        });

        const result = await simpleDownloadManager.startDownload(
            "job-disc-1",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
            true,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("No releases available");
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-disc-1" },
                data: expect.objectContaining({
                    status: "failed",
                    metadata: expect.objectContaining({
                        statusText: "No sources available",
                    }),
                }),
            }),
        );
        expect(
            mockDiscoverWeeklyService.checkBatchCompletion,
        ).toHaveBeenCalledWith("batch-1");
    });

    it("uses same-artist fallback for library downloads when no releases are available", async () => {
        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("No releases available"),
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-lib-1",
            discoveryBatchId: null,
            artistMbid: "artist-mbid-1",
            metadata: { artistMbid: "artist-mbid-1", albumTitle: "Album" },
        });
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValueOnce({
                retried: true,
                failed: false,
                jobId: "job-lib-fallback-1",
            });

        const result = await simpleDownloadManager.startDownload(
            "job-lib-1",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
            false,
        );

        expect(result).toEqual({ success: true });
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-lib-1" }),
            "No sources available",
        );
        fallbackSpy.mockRestore();
    });

    it("skips same-artist fallback for discovery jobs when album is not found", async () => {
        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("album not found in lidarr"),
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-disc-2",
            discoveryBatchId: "batch-2",
            metadata: { artistMbid: "artist-mbid-1" },
        });
        const fallbackSpy = jest.spyOn(
            simpleDownloadManager as any,
            "tryNextAlbumFromArtist",
        );

        const result = await simpleDownloadManager.startDownload(
            "job-disc-2",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
            true,
        );

        expect(result.success).toBe(false);
        expect(fallbackSpy).not.toHaveBeenCalled();
        expect(
            mockDiscoverWeeklyService.checkBatchCompletion,
        ).toHaveBeenCalledWith("batch-2");
        fallbackSpy.mockRestore();
    });

    it("starts fallback download for library jobs when Lidarr has no releases", async () => {
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValue({
                retried: true,
                failed: false,
                jobId: "job-fallback-library",
            });

        try {
            mockLidarrService.addAlbum.mockRejectedValueOnce(
                new Error("No releases available right now"),
            );

            mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
                id: "job-lib-1",
                artistMbid: "artist-mbid-lib",
                metadata: {
                    artistMbid: "artist-mbid-lib",
                    artistName: "Artist",
                },
            });

            const result = await simpleDownloadManager.startDownload(
                "job-lib-1",
                "Artist",
                "Album",
                "album-mbid-1",
                "user-1",
            );

            expect(result.success).toBe(true);
            expect(result.error).toBeUndefined();
            expect(fallbackSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: "job-lib-1",
                    artistMbid: "artist-mbid-lib",
                }),
                "No sources available",
            );
            expect(
                mockPrisma.downloadJob.update.mock.calls.some(([args]: any) => {
                    return (
                        args?.where?.id === "job-lib-1" &&
                        args?.data?.status === "failed"
                    );
                }),
            ).toBe(false);
        } finally {
            fallbackSpy.mockRestore();
        }
    });

    it("marks no-sources failure as terminal when library job has no artist MBID", async () => {
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-lib-no-artist",
            });

        try {
            mockLidarrService.addAlbum.mockRejectedValueOnce(
                new Error("No releases available"),
            );
            mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
                id: "job-lib-no-artist",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            });

            const result = await simpleDownloadManager.startDownload(
                "job-lib-no-artist",
                "Artist",
                "Album",
                "album-mbid-1",
                "user-1",
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("No releases available");
            expect(fallbackSpy).not.toHaveBeenCalled();
            expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "job-lib-no-artist" },
                    data: expect.objectContaining({
                        status: "failed",
                        metadata: expect.objectContaining({
                            statusText: "No sources available",
                        }),
                    }),
                }),
            );
        } finally {
            fallbackSpy.mockRestore();
        }
    });

    it("skips fallback for discovery jobs when the album is missing in Lidarr", async () => {
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValue({
                retried: true,
                failed: false,
                jobId: "job-unused",
            });

        try {
            mockLidarrService.addAlbum.mockRejectedValueOnce(
                new Error("album not found in Lidarr"),
            );

            mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
                id: "job-disc-missing",
                discoveryBatchId: "batch-missing",
                metadata: { artistMbid: "artist-mbid-2" },
            });

            const result = await simpleDownloadManager.startDownload(
                "job-disc-missing",
                "Artist",
                "Album",
                "album-mbid-2",
                "user-22",
                true,
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain("album not found");
            expect(fallbackSpy).not.toHaveBeenCalled();
            expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "job-disc-missing" },
                    data: expect.objectContaining({
                        status: "failed",
                        metadata: expect.objectContaining({
                            statusText: "Failed to start",
                        }),
                    }),
                }),
            );
            expect(
                mockDiscoverWeeklyService.checkBatchCompletion,
            ).toHaveBeenCalledWith("batch-missing");
        } finally {
            fallbackSpy.mockRestore();
        }
    });

    it("surfaces acquisition error metadata when Lidarr rejects with typed error", async () => {
        const typedError = new AcquisitionError(
            "album not found anywhere",
            AcquisitionErrorType.ALBUM_NOT_FOUND,
            false,
        );
        mockLidarrService.addAlbum.mockRejectedValueOnce(typedError);
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-acq-1",
            metadata: {},
        });

        const result = await simpleDownloadManager.startDownload(
            "job-acq-1",
            "Artist",
            "Album",
            "album-mbid-acq",
            "user-acq",
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe(AcquisitionErrorType.ALBUM_NOT_FOUND);
        expect(result.isRecoverable).toBe(false);
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-acq-1" },
                data: expect.objectContaining({
                    status: "failed",
                    metadata: expect.objectContaining({
                        statusText: "Failed to start",
                    }),
                }),
            }),
        );
    });

    it("treats non-retriable Lidarr errors as terminal and skips fallback attempts", async () => {
        const fallbackSpy = jest.spyOn(
            simpleDownloadManager as any,
            "tryNextAlbumFromArtist",
        );

        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("rate limit exceeded"),
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-err-no-fallback",
            metadata: {
                artistName: "Artist",
                albumTitle: "Album",
            },
        });

        const result = await simpleDownloadManager.startDownload(
            "job-err-no-fallback",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("rate limit exceeded");
        expect(result.isRecoverable).toBeUndefined();
        expect(fallbackSpy).not.toHaveBeenCalled();
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-err-no-fallback" },
                data: expect.objectContaining({
                    status: "failed",
                    metadata: expect.objectContaining({
                        statusText: "Failed to start",
                    }),
                }),
            }),
        );
        expect(
            mockDiscoverWeeklyService.checkBatchCompletion,
        ).not.toHaveBeenCalled();

        fallbackSpy.mockRestore();
    });

    it("onDownloadGrabbed is idempotent when download is already tracked", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce({
                    id: "job-dup-1",
                });
                return operation(tx);
            },
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-1",
            "album-mbid-1",
            "Album",
            "Artist",
            77,
        );

        expect(result).toEqual({ matched: true, jobId: "job-dup-1" });
    });

    it("onDownloadGrabbed matches by target MBID and updates existing job", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce(null);
                tx.downloadJob.findMany.mockResolvedValueOnce([
                    {
                        id: "job-2",
                        status: "pending",
                        lidarrRef: null,
                        targetMbid: "album-mbid-1",
                        metadata: { artistName: "Artist", albumTitle: "Album" },
                    },
                ]);
                tx.downloadJob.update.mockResolvedValueOnce({});
                return operation(tx);
            },
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-2",
            "album-mbid-1",
            "Album",
            "Artist",
            77,
        );

        expect(result).toEqual({ matched: true, jobId: "job-2" });
    });

    it("onDownloadGrabbed matches by subject text when MBID-based strategies miss", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce(null);
                tx.downloadJob.findMany.mockResolvedValueOnce([
                    {
                        id: "job-subject-1",
                        status: "processing",
                        lidarrRef: null,
                        targetMbid: "other-mbid",
                        subject: "Artist Name - Album Name",
                        metadata: {
                            artistName: "Different Artist",
                            albumTitle: "Different Album",
                        },
                    },
                ]);
                tx.downloadJob.update.mockResolvedValueOnce({});
                return operation(tx);
            },
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-subject-1",
            "album-mbid-miss",
            "Album Name",
            "Artist Name",
            501,
        );

        expect(result).toEqual({ matched: true, jobId: "job-subject-1" });
    });

    it("onDownloadGrabbed returns unmatched when duplicate album job already exists", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce(null);
                tx.downloadJob.findMany
                    .mockResolvedValueOnce([
                        {
                            id: "job-candidate-1",
                            status: "pending",
                            lidarrRef: null,
                            targetMbid: "different-mbid",
                            subject: "Not Matching Subject",
                            metadata: {
                                artistName: "Other Artist",
                                albumTitle: "Other Album",
                            },
                        },
                    ])
                    .mockResolvedValueOnce([
                        {
                            id: "job-dup-1",
                            status: "completed",
                            metadata: {
                                artistName: "Artist",
                                albumTitle: "Album",
                            },
                        },
                    ]);
                return operation(tx);
            },
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-dup-1",
            "album-mbid-dup",
            "Album",
            "Artist",
            0,
        );

        expect(result).toEqual({ matched: false });
    });

    it("onDownloadGrabbed does not create tracking job when user cannot be inferred", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(null);
                tx.downloadJob.findMany
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([]);
                return operation(tx);
            },
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-no-user",
            "album-mbid-1",
            "Album",
            "Artist",
            77,
        );

        expect(result).toEqual({ matched: false });
    });

    it("onDownloadComplete returns quickly for already-completed jobs", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce({
                    id: "job-complete-1",
                    discoveryBatchId: "batch-1",
                    metadata: {
                        batchId: "download-batch-1",
                        spotifyImportJobId: "spotify-import-1",
                    },
                });
                return operation(tx);
            },
        );

        const result =
            await simpleDownloadManager.onDownloadComplete("dl-complete-1");

        expect(result).toEqual({
            jobId: "job-complete-1",
            batchId: "batch-1",
            downloadBatchId: "download-batch-1",
            spotifyImportJobId: "spotify-import-1",
        });
    });

    it("onDownloadComplete marks duplicates completed and sends notification", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce(null);
                tx.downloadJob.findMany.mockResolvedValueOnce([
                    {
                        id: "job-main",
                        userId: "user-1",
                        subject: "Artist - Album",
                        status: "processing",
                        lidarrRef: "dl-main",
                        targetMbid: "album-mbid-main",
                        discoveryBatchId: "batch-main",
                        metadata: {
                            artistName: "Artist",
                            albumTitle: "Album",
                            spotifyImportJobId: "spotify-import-main",
                            artistId: "artist-1",
                        },
                    },
                    {
                        id: "job-dup",
                        userId: "user-1",
                        subject: "Artist - Album",
                        status: "processing",
                        lidarrRef: "dl-dup",
                        targetMbid: "album-mbid-main",
                        discoveryBatchId: null,
                        metadata: {
                            artistName: "Artist",
                            albumTitle: "Album",
                        },
                    },
                ]);
                tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 1 });
                tx.downloadJob.update.mockResolvedValueOnce({});
                return operation(tx);
            },
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-main",
            "album-mbid-main",
            "Artist",
            "Album",
            77,
        );

        expect(result).toEqual({
            jobId: "job-main",
            batchId: "batch-main",
            downloadBatchId: undefined,
            spotifyImportJobId: "spotify-import-main",
        });
        expect(
            mockNotificationPolicyService.evaluateNotification,
        ).toHaveBeenCalledWith("job-main", "complete");
        expect(
            mockNotificationService.notifyDownloadComplete,
        ).toHaveBeenCalled();
        expect(
            mockDiscoverWeeklyService.checkBatchCompletion,
        ).toHaveBeenCalledWith("batch-main");
        expect(
            mockSpotifyImportService.checkImportCompletion,
        ).toHaveBeenCalledWith("spotify-import-main");
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-main" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        notificationSent: true,
                    }),
                }),
            }),
        );
    });

    it("onDownloadComplete continues when notification evaluation fails", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce(null);
                tx.downloadJob.findMany.mockResolvedValueOnce([
                    {
                        id: "job-complete-policy-fail",
                        userId: "user-1",
                        subject: "Artist - Album",
                        status: "processing",
                        lidarrRef: "dl-policy-fail",
                        targetMbid: "mbid-policy-fail",
                        discoveryBatchId: null,
                        metadata: {
                            artistName: "Artist",
                            albumTitle: "Album",
                        },
                    },
                ]);
                tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 0 });
                tx.downloadJob.update.mockResolvedValueOnce({});
                return operation(tx);
            },
        );

        mockNotificationPolicyService.evaluateNotification.mockRejectedValueOnce(
            new Error("policy unavailable"),
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-policy-fail",
            "mbid-policy-fail",
            "Artist",
            "Album",
            99,
        );

        expect(result).toEqual({
            jobId: "job-complete-policy-fail",
            batchId: undefined,
            downloadBatchId: undefined,
            spotifyImportJobId: undefined,
        });
        expect(
            mockNotificationService.notifyDownloadComplete,
        ).not.toHaveBeenCalled();
    });

    it("onDownloadComplete preserves null artistId and runs completion checks after a subscriber throws", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce(null);
                tx.downloadJob.findMany.mockResolvedValueOnce([
                    {
                        id: "job-emitter-failure",
                        userId: "user-1",
                        subject: "Artist - Album",
                        status: "processing",
                        lidarrRef: "dl-emitter-failure",
                        targetMbid: "mbid-emitter-failure",
                        discoveryBatchId: "batch-emitter-failure",
                        metadata: {
                            artistName: "Artist",
                            albumTitle: "Album",
                            artistId: null,
                            spotifyImportJobId: "spotify-emitter-failure",
                        },
                    },
                ]);
                return operation(tx);
            },
        );
        const unsubscribe = (simpleDownloadManager as any).downloadJobEvents.on(
            "download.completed",
            async () => {
                throw new Error("subscriber failed");
            },
        );

        try {
            await expect(
                simpleDownloadManager.onDownloadComplete(
                    "dl-emitter-failure",
                    "mbid-emitter-failure",
                    "Artist",
                    "Album",
                ),
            ).resolves.toEqual(
                expect.objectContaining({ jobId: "job-emitter-failure" }),
            );
        } finally {
            unsubscribe();
        }
        expect(
            mockNotificationService.notifyDownloadComplete,
        ).toHaveBeenCalledWith("user-1", "Artist - Album", undefined, null);
        expect(
            mockDiscoverWeeklyService.checkBatchCompletion,
        ).toHaveBeenCalledWith("batch-emitter-failure");
        expect(
            mockSpotifyImportService.checkImportCompletion,
        ).toHaveBeenCalledWith("spotify-emitter-failure");
    });

    it("onImportFailed records failure and removes queue item for retry", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce({
                    id: "job-fail-1",
                    status: "processing",
                    metadata: {
                        failureCount: 0,
                        previousDownloadIds: [],
                    },
                });
                tx.downloadJob.update.mockResolvedValueOnce({});
                return operation(tx);
            },
        );
        const result = await simpleDownloadManager.onImportFailed(
            "dl-fail-1",
            "Import failed",
        );

        expect(result).toEqual({
            retried: true,
            failed: false,
            jobId: "job-fail-1",
        });
        expect(mockLidarrService.blocklistAndRemove).toHaveBeenCalledWith(
            "dl-fail-1",
            false,
        );
    });

    it("clears failed Lidarr queue items and triggers album search", async () => {
        mockLidarrService.clearFailedQueue.mockResolvedValueOnce({
            removed: 2,
            errors: [],
        });

        const signal = new AbortController().signal;
        const result = await simpleDownloadManager.clearLidarrQueue(signal);

        expect(result.removed).toBe(2);
        expect(result.errors).toEqual([]);
        expect(mockLidarrService.clearFailedQueue).toHaveBeenCalledWith(signal);
    });

    it("returns aggregate download stats by status", async () => {
        mockPrisma.downloadJob.count
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(4)
            .mockResolvedValueOnce(5);

        const stats = await simpleDownloadManager.getStats();
        expect(stats).toEqual({
            pending: 2,
            processing: 3,
            completed: 4,
            failed: 5,
        });
    });

    it("falls back to default max attempts when user config lookup fails", async () => {
        mockPrisma.userDiscoverConfig.findUnique.mockRejectedValueOnce(
            new Error("db unavailable"),
        );

        const attempts = await (simpleDownloadManager as any).getMaxAttempts(
            "user-err",
        );
        expect(attempts).toBe(3);
    });

    it("retries serializable transaction conflicts with exponential backoff", async () => {
        const serializationError = Object.assign(
            new Error("could not serialize access due to concurrent update"),
            { code: "P2034" },
        );
        mockPrisma.$transaction
            .mockRejectedValueOnce(serializationError)
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) => {
                    const tx = makeTx();
                    tx.downloadJob.findFirst.mockResolvedValue(null);
                    return operation(tx);
                },
            );

        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        const result = await (simpleDownloadManager as any).withTransaction(
            async () => "ok",
            { maxRetries: 3, logPrefix: "[TX-TEST]" },
        );

        expect(result).toBe("ok");
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        timeoutSpy.mockRestore();
    });

    it("does not retry non-serialization transaction errors", async () => {
        mockPrisma.$transaction.mockRejectedValueOnce(new Error("boom"));

        await expect(
            (simpleDownloadManager as any).withTransaction(async () => "ok", {
                maxRetries: 3,
                logPrefix: "[TX-TEST]",
            }),
        ).rejects.toThrow("boom");
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("markJobExhausted merges duplicate completed jobs for the same album", async () => {
        const job = {
            id: "job-exhaust-1",
            userId: "user-1",
            subject: "Artist - Album",
            metadata: {
                artistName: "Artist",
                albumTitle: "Album",
            },
        };

        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-dup-complete",
            metadata: {
                artistName: "Artist",
                albumTitle: "Album",
            },
        });

        const result = await (simpleDownloadManager as any).markJobExhausted(
            job,
            "No releases available",
        );

        expect(result).toEqual({
            retried: false,
            failed: false,
            jobId: "job-exhaust-1",
        });
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-exhaust-1" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        mergedWithJob: "job-dup-complete",
                    }),
                }),
            }),
        );
        expect(
            mockNotificationService.notifyDownloadFailed,
        ).not.toHaveBeenCalled();
    });

    it("markJobExhausted marks failed, checks discovery completion, and sends policy-approved notification", async () => {
        const job = {
            id: "job-exhaust-2",
            userId: "user-22",
            subject: "Artist - Exhausted Album",
            discoveryBatchId: "batch-exhaust-2",
            metadata: {
                artistName: "Artist",
                albumTitle: "Exhausted Album",
            },
        };

        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce(
            {
                shouldNotify: true,
                reason: "policy allows",
            } as any,
        );

        const result = await (simpleDownloadManager as any).markJobExhausted(
            job,
            "all fallback options failed",
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-exhaust-2",
        });
        expect(
            mockDiscoverWeeklyService.checkBatchCompletion,
        ).toHaveBeenCalledWith("batch-exhaust-2");
        expect(
            mockNotificationService.notifyDownloadFailed,
        ).toHaveBeenCalledWith(
            "user-22",
            "Artist - Exhausted Album",
            "all fallback options failed",
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-exhaust-2" },
                data: expect.objectContaining({
                    status: "failed",
                }),
            }),
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-exhaust-2" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        notificationSent: true,
                    }),
                }),
            }),
        );
    });

    it("blocklistAndRetry and removeFromLidarrQueue clean up matching queue entries", async () => {
        await (simpleDownloadManager as any).blocklistAndRetry(
            "dl-cleanup-1",
            777,
        );
        expect(mockLidarrService.blocklistAndRemove).toHaveBeenCalledWith(
            "dl-cleanup-1",
            false,
        );

        await (simpleDownloadManager as any).removeFromLidarrQueue(
            "dl-cleanup-2",
        );
        expect(mockLidarrService.blocklistAndRemove).toHaveBeenCalledWith(
            "dl-cleanup-2",
            false,
        );
    });

    it("blocklistAndRetry delegates missing-item handling to LidarrService", async () => {
        await (simpleDownloadManager as any).blocklistAndRetry(
            "dl-missing",
            999,
        );

        expect(mockLidarrService.blocklistAndRemove).toHaveBeenCalledWith(
            "dl-missing",
            false,
        );
    });

    it("onDownloadGrabbed matches by lidarr MBID metadata when target MBID misses", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-lidarr-mbid",
                status: "processing",
                lidarrRef: null,
                targetMbid: "other-mbid",
                metadata: {
                    lidarrMbid: "lidarr-mbid-1",
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            },
        ]);
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-lidarr-mbid",
            "lidarr-mbid-1",
            "Album",
            "Artist",
            700,
        );

        expect(result).toEqual({ matched: true, jobId: "job-lidarr-mbid" });
    });

    it("onDownloadGrabbed matches by lidarrAlbumId when MBID strategies miss", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-lidarr-album",
                status: "pending",
                lidarrRef: null,
                targetMbid: "different",
                lidarrAlbumId: null,
                metadata: {
                    lidarrAlbumId: 991,
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            },
        ]);
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-lidarr-album",
            "mbid-miss",
            "Album",
            "Artist",
            991,
        );

        expect(result).toEqual({ matched: true, jobId: "job-lidarr-album" });
    });

    it("onDownloadGrabbed creates a tracking job when no matches or duplicates exist", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-create-1",
            });
        tx.downloadJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        tx.downloadJob.create.mockResolvedValueOnce({
            id: "tracking-created-1",
        });
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-create-1",
            "mbid-create-1",
            "Album Create",
            "Artist Create",
            5001,
        );

        expect(result).toEqual({ matched: true, jobId: "tracking-created-1" });
        expect(tx.downloadJob.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: "user-create-1",
                    subject: "Artist Create - Album Create",
                    targetMbid: "mbid-create-1",
                    lidarrRef: "dl-create-1",
                    lidarrAlbumId: 5001,
                }),
            }),
        );
    });

    // F23: duplicate/concurrent Lidarr Grab webhook hits the partial unique
    // index (DownloadJob_targetMbid_active_unique) and today surfaces as an
    // uncaught P2002 -> 500 at the webhook route. These pin the fix: the
    // loser must resolve coherently instead of throwing.
    it("onDownloadGrabbed resolves the loser with the winner's jobId when the tracking-job create hits P2002 (F23)", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");

        const winnerTx = makeTx();
        winnerTx.downloadJob.findFirst
            .mockResolvedValueOnce(null) // idempotency check (metadata.downloadId)
            .mockResolvedValueOnce(null) // duplicate check by targetMbid
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-race-1",
            }); // recentJob (infer userId)
        winnerTx.downloadJob.findMany
            .mockResolvedValueOnce([]) // active unassigned jobs
            .mockResolvedValueOnce([]); // duplicate check by artist+album
        winnerTx.downloadJob.create.mockResolvedValueOnce({
            id: "winner-job-1",
        });

        const loserTx = makeTx();
        loserTx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-race-1",
            });
        loserTx.downloadJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        loserTx.downloadJob.create.mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on the fields: (`targetMbid`)",
                { code: "P2002", clientVersion: "test" },
            ),
        );

        mockPrisma.$transaction
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) =>
                    operation(winnerTx),
            )
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) =>
                    operation(loserTx),
            );

        // The loser's post-abort re-find must run against the plain `prisma`
        // singleton (a fresh implicit transaction), never the dead `tx` from
        // the rolled-back transaction.
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "winner-job-1",
        });

        const winnerResult = await simpleDownloadManager.onDownloadGrabbed(
            "dl-race-1",
            "mbid-race-1",
            "Album Race",
            "Artist Race",
            42,
        );
        const loserResult = await simpleDownloadManager.onDownloadGrabbed(
            "dl-race-1",
            "mbid-race-1",
            "Album Race",
            "Artist Race",
            42,
        );

        expect(winnerResult).toEqual({ matched: true, jobId: "winner-job-1" });
        expect(loserResult).toEqual({ matched: true, jobId: "winner-job-1" });
        expect(mockPrisma.downloadJob.findFirst).toHaveBeenCalledTimes(1);
        expect(mockPrisma.downloadJob.findFirst).toHaveBeenCalledWith({
            where: {
                OR: [
                    { lidarrRef: "dl-race-1" },
                    {
                        metadata: {
                            path: ["downloadId"],
                            equals: "dl-race-1",
                        },
                    },
                ],
            },
        });
        // Exactly one active row actually got created — the loser's create
        // was attempted (and rejected by the DB constraint) but produced no
        // second row.
        expect(winnerTx.downloadJob.create).toHaveBeenCalledTimes(1);
        expect(loserTx.downloadJob.create).toHaveBeenCalledTimes(1);
    });

    it("onDownloadGrabbed resolves via re-find when the matched-job update hits P2002 (F23)", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");

        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null); // idempotency check
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "matched-job-1",
                status: "pending",
                lidarrRef: null,
                targetMbid: null,
                metadata: {
                    artistName: "Artist Update",
                    albumTitle: "Album Update",
                },
            },
        ]);
        tx.downloadJob.update.mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on the fields: (`targetMbid`)",
                { code: "P2002", clientVersion: "test" },
            ),
        );
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "already-active-job-1",
        });

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-update-race-1",
            "mbid-update-race-1",
            "Album Update",
            "Artist Update",
            77,
        );

        expect(result).toEqual({
            matched: true,
            jobId: "already-active-job-1",
        });
        expect(tx.downloadJob.update).toHaveBeenCalledTimes(1);
    });

    it("onDownloadGrabbed resolves a non-throwing {matched:false} when a P2002 winner can't be found", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");

        const tx = makeTx();
        tx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-edge-1",
            });
        tx.downloadJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        tx.downloadJob.create.mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on the fields: (`targetMbid`)",
                { code: "P2002", clientVersion: "test" },
            ),
        );
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );
        // No row matches the re-find (edge case, e.g. a different downloadId
        // raced on the same targetMbid) -- must not throw.
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);

        await expect(
            simpleDownloadManager.onDownloadGrabbed(
                "dl-orphan-race-1",
                "mbid-orphan-1",
                "Album Orphan",
                "Artist Orphan",
                11,
            ),
        ).resolves.toEqual({ matched: false });
    });

    it("onDownloadGrabbed still rejects non-P2002 errors from the grab transaction", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "recent-artist-job",
                userId: "user-err-1",
            });
        tx.downloadJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        tx.downloadJob.create.mockRejectedValueOnce(
            new Error("connection reset"),
        );
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        await expect(
            simpleDownloadManager.onDownloadGrabbed(
                "dl-other-error-1",
                "mbid-other-error-1",
                "Album Err",
                "Artist Err",
                5,
            ),
        ).rejects.toThrow("connection reset");
        // The non-P2002 path must not call the P2002 recovery re-find.
        expect(mockPrisma.downloadJob.findFirst).not.toHaveBeenCalled();
    });

    it("onDownloadComplete matches by lidarrAlbumId", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-complete-album-id",
                userId: "user-complete-1",
                subject: "Artist - Album",
                status: "processing",
                lidarrRef: "some-other-id",
                lidarrAlbumId: 12345,
                targetMbid: "mbid-complete",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            },
        ]);
        tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-complete-by-album-id",
            undefined,
            undefined,
            undefined,
            12345,
        );

        expect(result.jobId).toBe("job-complete-album-id");
    });

    it("onDownloadComplete matches by previousDownloadIds and completes the job", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-complete-prev-id",
                userId: "user-prev-id",
                subject: "Artist Prev - Album Prev",
                status: "processing",
                lidarrRef: "current-id",
                targetMbid: "mbid-prev",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Prev",
                    albumTitle: "Album Prev",
                    previousDownloadIds: ["old-download-id"],
                },
            },
        ]);
        tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "old-download-id",
            undefined,
            undefined,
            undefined,
            undefined,
        );

        expect(result.jobId).toBe("job-complete-prev-id");
    });

    it("onDownloadComplete returns empty result when no active job matches", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-no-match",
            "mbid-no-match",
            "Artist",
            "Album",
            101,
        );

        expect(result).toEqual({});
        expect(
            mockNotificationService.notifyDownloadComplete,
        ).not.toHaveBeenCalled();
    });

    it("onImportFailed removes queue entry even when no matching job exists", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );
        const result = await simpleDownloadManager.onImportFailed(
            "dl-no-job",
            "Import failed",
        );

        expect(result).toEqual({ retried: false, failed: false });
        expect(mockLidarrService.blocklistAndRemove).toHaveBeenCalledWith(
            "dl-no-job",
            false,
        );
    });

    it("onImportFailed deduplicates rapid repeat failures", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-repeat-failure",
            status: "processing",
            metadata: {
                lastFailureAt: new Date().toISOString(),
                failureCount: 2,
                previousDownloadIds: ["dl-repeat"],
            },
        });
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx),
        );

        const result = await simpleDownloadManager.onImportFailed(
            "dl-repeat",
            "same failure repeated",
        );

        expect(result).toEqual({
            retried: false,
            failed: false,
            jobId: "job-repeat-failure",
        });
        expect(tx.downloadJob.update).not.toHaveBeenCalled();
        expect(mockLidarrService.blocklistAndRemove).not.toHaveBeenCalled();
    });

    it("markJobExhausted suppresses notifications when policy blocks them", async () => {
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce(
            {
                shouldNotify: false,
                reason: "notification cooldown",
            } as any,
        );

        const result = await (simpleDownloadManager as any).markJobExhausted(
            {
                id: "job-policy-blocked",
                userId: "user-policy-blocked",
                subject: "Artist - Album",
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            },
            "all attempts exhausted",
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-policy-blocked",
        });
        expect(
            mockNotificationService.notifyDownloadFailed,
        ).not.toHaveBeenCalled();
    });

    it("markJobExhausted continues when policy evaluation throws", async () => {
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockNotificationPolicyService.evaluateNotification.mockRejectedValueOnce(
            new Error("policy unavailable"),
        );

        const result = await (simpleDownloadManager as any).markJobExhausted(
            {
                id: "job-policy-error",
                userId: "user-policy-error",
                subject: "Artist - Album",
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            },
            "all attempts exhausted",
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-policy-error",
        });
        expect(
            mockNotificationService.notifyDownloadFailed,
        ).not.toHaveBeenCalled();
    });

    it("clearLidarrQueue returns configuration error when Lidarr settings are missing", async () => {
        mockLidarrService.clearFailedQueue.mockResolvedValueOnce({
            removed: 0,
            errors: ["Lidarr not configured"],
        });

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result).toEqual({
            removed: 0,
            errors: ["Lidarr not configured"],
        });
    });

    it("falls back to default retry attempts when user settings fetch fails", async () => {
        mockPrisma.userDiscoverConfig.findUnique.mockRejectedValueOnce(
            new Error("db down"),
        );

        const attempts = await (simpleDownloadManager as any).getMaxAttempts(
            "user-fallback",
        );

        expect(attempts).toBe(3);
    });

    it("uses system configured music path when system settings are missing", async () => {
        mockGetSystemSettings.mockResolvedValueOnce(null as any);
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            metadata: { tier: "primary", similarity: 0.97 },
        });

        const result = await simpleDownloadManager.startDownload(
            "job-missing-settings",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
        );

        expect(result.success).toBe(true);
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-1",
            "Artist",
            "Album",
            "/music-default",
            "artist-mbid-1",
            false,
        );
    });

    it("continues startup when MusicBrainz artist lookup fails", async () => {
        mockMusicBrainzService.getReleaseGroup.mockRejectedValueOnce(
            new Error("musicbrainz timeout"),
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            metadata: { tier: "secondary" },
        });

        const result = await simpleDownloadManager.startDownload(
            "job-mb-fail",
            "Artist",
            "Album",
            "album-mbid-2",
            "user-1",
        );

        expect(result.success).toBe(true);
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-2",
            "Artist",
            "Album",
            "/music",
            undefined,
            false,
        );
    });

    it("retries a transaction when Prisma reports serialization conflicts", async () => {
        const svc = simpleDownloadManager as any;
        let attempts = 0;
        const serializationError: any = new Error(
            "Could not serialize access due to concurrent transaction",
        );
        serializationError.code = "P2034";

        mockPrisma.$transaction.mockImplementation(
            async (operation: (tx: any) => Promise<any>) => {
                attempts++;
                if (attempts === 1) {
                    throw serializationError;
                }
                return operation(makeTx());
            },
        );

        const result = await svc.withTransaction(
            async () => {
                return "retried";
            },
            { maxRetries: 2, logPrefix: "[SDM]" },
        );

        expect(result).toBe("retried");
        expect(attempts).toBe(2);
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });
});
