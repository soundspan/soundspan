import axios from "axios";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { prisma } from "../../utils/db";
import { lidarrService, AcquisitionError, AcquisitionErrorType } from "../lidarr";
import { musicBrainzService } from "../musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { notificationService } from "../notificationService";
import { notificationPolicyService } from "../notificationPolicyService";
import { discoverWeeklyService } from "../discoverWeekly";
import { spotifyImportService } from "../spotifyImport";

jest.mock("axios");

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
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

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;

const mockPrisma = prisma as any;
const mockLidarrService = lidarrService as jest.Mocked<typeof lidarrService>;
const mockMusicBrainzService = musicBrainzService as jest.Mocked<
    typeof musicBrainzService
>;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockNotificationService = notificationService as jest.Mocked<
    typeof notificationService
>;
const mockNotificationPolicyService =
    notificationPolicyService as jest.Mocked<typeof notificationPolicyService>;
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
            }
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
        mockNotificationService.notifyDownloadComplete.mockResolvedValue(undefined as any);
        mockNotificationService.notifyDownloadFailed.mockResolvedValue(undefined as any);
        mockDiscoverWeeklyService.checkBatchCompletion.mockResolvedValue(undefined as any);
        mockSpotifyImportService.checkImportCompletion.mockResolvedValue(undefined as any);

        mockAxiosGet.mockResolvedValue({ data: { records: [] } });
        mockAxiosPost.mockResolvedValue({});
        mockAxiosDelete.mockResolvedValue({});
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
            "user-1"
        );

        expect(result.success).toBe(true);
        expect(result.correlationId).toBeDefined();
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-1",
            "Artist",
            "Album",
            "/music",
            "artist-mbid-1",
            false
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
            })
        );
    });

    it("fails discovery download with no sources and triggers batch completion check", async () => {
        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("No releases available")
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
            true
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
            })
        );
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-1"
        );
    });

    it("uses same-artist fallback for library downloads when no releases are available", async () => {
        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("No releases available")
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
            false
        );

        expect(result).toEqual({ success: true });
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-lib-1" }),
            "No sources available"
        );
        fallbackSpy.mockRestore();
    });

    it("skips same-artist fallback for discovery jobs when album is not found", async () => {
        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("album not found in lidarr")
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-disc-2",
            discoveryBatchId: "batch-2",
            metadata: { artistMbid: "artist-mbid-1" },
        });
        const fallbackSpy = jest.spyOn(
            simpleDownloadManager as any,
            "tryNextAlbumFromArtist"
        );

        const result = await simpleDownloadManager.startDownload(
            "job-disc-2",
            "Artist",
            "Album",
            "album-mbid-1",
            "user-1",
            true
        );

        expect(result.success).toBe(false);
        expect(fallbackSpy).not.toHaveBeenCalled();
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-2"
        );
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
                new Error("No releases available right now")
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
                "user-1"
            );

            expect(result.success).toBe(true);
            expect(result.error).toBeUndefined();
            expect(fallbackSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: "job-lib-1",
                    artistMbid: "artist-mbid-lib",
                }),
                "No sources available"
            );
            expect(
                mockPrisma.downloadJob.update.mock.calls.some(([args]: any) => {
                    return (
                        args?.where?.id === "job-lib-1" &&
                        args?.data?.status === "failed"
                    );
                })
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
                new Error("No releases available")
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
                "user-1"
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
                })
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
                new Error("album not found in Lidarr")
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
                true
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
                })
            );
            expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
                "batch-missing"
            );
        } finally {
            fallbackSpy.mockRestore();
        }
    });

    it("surfaces acquisition error metadata when Lidarr rejects with typed error", async () => {
        const typedError = new AcquisitionError(
            "album not found anywhere",
            AcquisitionErrorType.ALBUM_NOT_FOUND,
            false
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
            "user-acq"
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
            })
        );
    });

    it("treats non-retriable Lidarr errors as terminal and skips fallback attempts", async () => {
        const fallbackSpy = jest.spyOn(
            simpleDownloadManager as any,
            "tryNextAlbumFromArtist"
        );

        mockLidarrService.addAlbum.mockRejectedValueOnce(
            new Error("rate limit exceeded")
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
            "user-1"
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
            })
        );
        expect(mockDiscoverWeeklyService.checkBatchCompletion).not.toHaveBeenCalled();

        fallbackSpy.mockRestore();
    });

    it("onDownloadGrabbed is idempotent when download is already tracked", async () => {
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => {
                const tx = makeTx();
                tx.downloadJob.findFirst.mockResolvedValueOnce({ id: "job-dup-1" });
                return operation(tx);
            }
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-1",
            "album-mbid-1",
            "Album",
            "Artist",
            77
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
            }
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-2",
            "album-mbid-1",
            "Album",
            "Artist",
            77
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
            }
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-subject-1",
            "album-mbid-miss",
            "Album Name",
            "Artist Name",
            501
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
            }
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-dup-1",
            "album-mbid-dup",
            "Album",
            "Artist",
            0
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
            }
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-no-user",
            "album-mbid-1",
            "Album",
            "Artist",
            77
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
            }
        );

        const result = await simpleDownloadManager.onDownloadComplete("dl-complete-1");

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
            }
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-main",
            "album-mbid-main",
            "Artist",
            "Album",
            77
        );

        expect(result).toEqual({
            jobId: "job-main",
            batchId: "batch-main",
            downloadBatchId: undefined,
            spotifyImportJobId: "spotify-import-main",
        });
        expect(mockNotificationPolicyService.evaluateNotification).toHaveBeenCalledWith(
            "job-main",
            "complete"
        );
        expect(mockNotificationService.notifyDownloadComplete).toHaveBeenCalled();
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-main"
        );
        expect(mockSpotifyImportService.checkImportCompletion).toHaveBeenCalledWith(
            "spotify-import-main"
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-main" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        notificationSent: true,
                    }),
                }),
            })
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
            }
        );

        mockNotificationPolicyService.evaluateNotification.mockRejectedValueOnce(
            new Error("policy unavailable")
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-policy-fail",
            "mbid-policy-fail",
            "Artist",
            "Album",
            99
        );

        expect(result).toEqual({
            jobId: "job-complete-policy-fail",
            batchId: undefined,
            downloadBatchId: undefined,
            spotifyImportJobId: undefined,
        });
        expect(mockNotificationService.notifyDownloadComplete).not.toHaveBeenCalled();
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
            }
        );
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [{ id: 9, downloadId: "dl-fail-1" }],
            },
        });
        mockAxiosDelete.mockResolvedValueOnce({});

        const result = await simpleDownloadManager.onImportFailed(
            "dl-fail-1",
            "Import failed"
        );

        expect(result).toEqual({
            retried: true,
            failed: false,
            jobId: "job-fail-1",
        });
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            expect.stringContaining("/api/v1/queue/9?removeFromClient=true&blocklist=true&skipRedownload=false"),
            expect.any(Object)
        );
    });

    it("markStaleJobsAsFailed updates stale pending jobs in batch", async () => {
        const staleDate = new Date(Date.now() - 11 * 60 * 1000);
        const freshDate = new Date(Date.now() - 1 * 60 * 1000);

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "pending-stale",
                status: "pending",
                discoveryBatchId: "batch-pending-1",
                createdAt: staleDate,
            },
            {
                id: "pending-fresh",
                status: "pending",
                createdAt: freshDate,
            },
        ]);
        mockPrisma.downloadJob.updateMany.mockResolvedValueOnce({ count: 1 });

        const count = await simpleDownloadManager.markStaleJobsAsFailed();

        expect(count).toBe(1);
        expect(mockPrisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["pending-stale"] } },
                data: expect.objectContaining({
                    status: "failed",
                    error: "Download never started - timed out",
                }),
            })
        );
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-pending-1"
        );
    });

    it("clears failed Lidarr queue items and triggers album search", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 1,
                        albumId: 11,
                        status: "warning",
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                        statusMessages: [{ title: "err", messages: ["failed"] }],
                        title: "Album 11",
                    },
                    {
                        id: 2,
                        albumId: 22,
                        status: "failed",
                        trackedDownloadStatus: "error",
                        trackedDownloadState: "importFailed",
                        statusMessages: [{ title: "err", messages: ["failed"] }],
                        title: "Album 22",
                    },
                ],
            },
        });
        mockAxiosDelete.mockResolvedValue({});
        mockAxiosPost.mockResolvedValue({});

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result.removed).toBe(2);
        expect(result.errors).toEqual([]);
        expect(mockAxiosDelete).toHaveBeenCalledTimes(2);
        expect(mockAxiosPost).toHaveBeenCalledWith(
            "http://lidarr:8686/api/v1/command",
            {
                name: "AlbumSearch",
                albumIds: [11, 22],
            },
            expect.any(Object)
        );
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
            new Error("db unavailable")
        );

        const attempts = await (simpleDownloadManager as any).getMaxAttempts(
            "user-err"
        );
        expect(attempts).toBe(3);
    });

    it("retries serializable transaction conflicts with exponential backoff", async () => {
        const serializationError = Object.assign(
            new Error("could not serialize access due to concurrent update"),
            { code: "P2034" }
        );
        mockPrisma.$transaction
            .mockRejectedValueOnce(serializationError)
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) => {
                    const tx = makeTx();
                    tx.downloadJob.findFirst.mockResolvedValue(null);
                    return operation(tx);
                }
            );

        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        const result = await (simpleDownloadManager as any).withTransaction(
            async () => "ok",
            { maxRetries: 3, logPrefix: "[TX-TEST]" }
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
            })
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
            "No releases available"
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
            })
        );
        expect(mockNotificationService.notifyDownloadFailed).not.toHaveBeenCalled();
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
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce({
            shouldNotify: true,
            reason: "policy allows",
        } as any);

        const result = await (simpleDownloadManager as any).markJobExhausted(
            job,
            "all fallback options failed"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-exhaust-2",
        });
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-exhaust-2"
        );
        expect(mockNotificationService.notifyDownloadFailed).toHaveBeenCalledWith(
            "user-22",
            "Artist - Exhausted Album",
            "all fallback options failed"
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-exhaust-2" },
                data: expect.objectContaining({
                    status: "failed",
                }),
            })
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-exhaust-2" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        notificationSent: true,
                    }),
                }),
            })
        );
    });

    it("tryNextAlbumFromArtist marks job exhausted when no artist MBID is available", async () => {
        const job = {
            id: "job-no-artist",
            userId: "user-no-artist",
            subject: "Unknown - Missing Album",
            metadata: {
                artistName: "Unknown",
            },
        };
        const markSpy = jest
            .spyOn(simpleDownloadManager as any, "markJobExhausted")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-no-artist",
            });

        try {
            const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
                job,
                "missing artist mbid"
            );

            expect(result).toEqual({
                retried: false,
                failed: true,
                jobId: "job-no-artist",
            });
            expect(markSpy).toHaveBeenCalledWith(job, "missing artist mbid");
        } finally {
            markSpy.mockRestore();
        }
    });

    it("tryNextAlbumFromArtist skips fallback for spotify import jobs and triggers import completion", async () => {
        const markSpy = jest
            .spyOn(simpleDownloadManager as any, "markJobExhausted")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-spotify-1",
            });

        const spotifyJob = {
            id: "job-spotify-1",
            userId: "user-1",
            subject: "Artist - Exact Album",
            metadata: {
                artistName: "Artist",
                spotifyImportJobId: "spotify-import-1",
            },
        };

        const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
            spotifyJob,
            "exact album unavailable"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-spotify-1",
        });
        expect(markSpy).toHaveBeenCalledWith(
            spotifyJob,
            "exact album unavailable"
        );
        expect(mockSpotifyImportService.checkImportCompletion).toHaveBeenCalledWith(
            "spotify-import-1"
        );
        markSpy.mockRestore();
    });

    it("tryNextAlbumFromArtist marks the job exhausted if Lidarr album lookup fails", async () => {
        const job = {
            id: "job-fallback-error",
            userId: "user-err",
            targetMbid: "mbid-current",
            artistMbid: "artist-mbid-err",
            subject: "Artist Err - Album Err",
            metadata: {
                artistName: "Artist Err",
                artistMbid: "artist-mbid-err",
            },
        };

        const markSpy = jest
            .spyOn(simpleDownloadManager as any, "markJobExhausted")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-fallback-error",
            });

        try {
            mockLidarrService.getArtistAlbums.mockRejectedValueOnce(
                new Error("Lidarr unavailable")
            );

            const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
                job,
                "lidarr unavailable"
            );

            expect(result).toEqual({
                retried: false,
                failed: true,
                jobId: "job-fallback-error",
            });
            expect(markSpy).toHaveBeenCalledWith(job, "lidarr unavailable");
        } finally {
            markSpy.mockRestore();
        }
    });

    it("tryNextAlbumFromArtist creates a same-artist fallback job and starts it", async () => {
        const startSpy = jest
            .spyOn(simpleDownloadManager, "startDownload")
            .mockResolvedValue({
                success: true,
                correlationId: "corr-fallback",
            } as any);

        mockLidarrService.getArtistAlbums.mockResolvedValueOnce([
            {
                id: 301,
                title: "Already Tried",
                foreignAlbumId: "mbid-tried",
                albumType: "album",
            },
            {
                id: 302,
                title: "Next Studio Album",
                foreignAlbumId: "mbid-next",
                albumType: "album",
            },
        ] as any);
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            { id: "job-old", targetMbid: "mbid-tried" },
        ]);
        mockPrisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-fallback-1",
        });

        const job = {
            id: "job-base-1",
            userId: "user-1",
            targetMbid: "mbid-current",
            artistMbid: "artist-mbid-1",
            subject: "Artist - Current Album",
            metadata: {
                artistName: "Artist",
                artistMbid: "artist-mbid-1",
                downloadType: "library",
            },
        };

        const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
            job,
            "album exhausted"
        );

        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-base-1" },
                data: expect.objectContaining({
                    status: "exhausted",
                }),
            })
        );
        expect(mockPrisma.downloadJob.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    targetMbid: "mbid-next",
                    metadata: expect.objectContaining({
                        sameArtistFallback: true,
                        albumTitle: "Next Studio Album",
                    }),
                }),
            })
        );
        expect(startSpy).toHaveBeenCalledWith(
            "job-fallback-1",
            "Artist",
            "Next Studio Album",
            "mbid-next",
            "user-1"
        );
        expect(result).toEqual({
            retried: true,
            failed: false,
            jobId: "job-fallback-1",
        });
        startSpy.mockRestore();
    });

    it("reconcileWithLidarr completes jobs via MBID, lidarr MBID fallback, and parsed subject matching", async () => {
        const snapshot = {
            queue: new Map<string, any>(),
        } as any;

        const oldDate = new Date(Date.now() - 8 * 60 * 1000);
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-rec-1",
                status: "processing",
                targetMbid: "mbid-1",
                subject: "Artist One - Album One",
                discoveryBatchId: "batch-rec-1",
                createdAt: new Date(),
                metadata: {
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    albumMbid: "mbid-1",
                },
            },
            {
                id: "job-rec-2",
                status: "processing",
                targetMbid: "orig-2",
                subject: "Artist Two - Album Two",
                discoveryBatchId: null,
                createdAt: new Date(),
                metadata: {
                    artistName: "Artist Two",
                    albumTitle: "Album Two",
                    albumMbid: "orig-2",
                    lidarrMbid: "lidarr-2",
                },
            },
            {
                id: "job-rec-3",
                status: "processing",
                targetMbid: null,
                subject: "Artist Three - Album Three",
                discoveryBatchId: "batch-rec-3",
                createdAt: new Date(),
                metadata: {},
            },
            {
                id: "job-rec-4",
                status: "processing",
                targetMbid: "mbid-missing",
                subject: "Artist Four - Album Four",
                discoveryBatchId: null,
                createdAt: oldDate,
                metadata: {
                    artistName: "Artist Four",
                    albumTitle: "Album Four",
                },
            },
        ]);

        mockLidarrService.isAlbumAvailableInSnapshot.mockImplementation(
            (_snapshot: any, mbid?: string, artist?: string, album?: string) => {
                if (mbid === "mbid-1") return true;
                if (mbid === "lidarr-2") return true;
                if (artist === "Artist Three" && album === "Album Three") {
                    return true;
                }
                return false;
            }
        );

        const result = await simpleDownloadManager.reconcileWithLidarr(snapshot);

        expect(result.reconciled).toBe(3);
        expect(result.errors).toEqual([]);
        expect(result.snapshot).toBe(snapshot);
        expect(mockPrisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["job-rec-1", "job-rec-2", "job-rec-3"] } },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
                error: null,
            },
        });
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-rec-1"
        );
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-rec-3"
        );
    });

    it("reconcileWithLidarr skips processing when no snapshot is available", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-rec-skip",
                status: "processing",
                subject: "Artist - Album",
                metadata: {},
            },
        ]);

        const result = await simpleDownloadManager.reconcileWithLidarr(undefined);

        expect(result).toEqual({ reconciled: 0, errors: [] });
        expect(mockPrisma.downloadJob.updateMany).not.toHaveBeenCalled();
    });

    it("syncWithLidarrQueue handles reset, increment, replacement, completion, and failure transitions", async () => {
        const snapshot = {
            queue: new Map<string, any>([
                [
                    "dl-found-1",
                    {
                        downloadId: "dl-found-1",
                        title: "Artist One - Album One",
                    },
                ],
                [
                    "dl-replacement-3",
                    {
                        downloadId: "dl-replacement-3",
                        title: "Artist Three - Album Three WEB",
                    },
                ],
            ]),
        } as any;

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-sync-1",
                status: "processing",
                lidarrRef: "dl-found-1",
                targetMbid: "mbid-one",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    queueSyncMissingCount: 2,
                },
            },
            {
                id: "job-sync-2",
                status: "processing",
                lidarrRef: "dl-missing-2",
                targetMbid: "mbid-two",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Two",
                    albumTitle: "Album Two",
                    queueSyncMissingCount: 1,
                },
            },
            {
                id: "job-sync-3",
                status: "processing",
                lidarrRef: "dl-missing-3",
                targetMbid: "mbid-three",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Three",
                    albumTitle: "Album Three",
                    queueSyncMissingCount: 2,
                },
            },
            {
                id: "job-sync-4",
                status: "processing",
                lidarrRef: "dl-missing-4",
                targetMbid: "mbid-available",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Four",
                    albumTitle: "Album Four",
                    queueSyncMissingCount: 2,
                },
            },
            {
                id: "job-sync-5",
                status: "processing",
                lidarrRef: "dl-missing-5",
                targetMbid: "mbid-fail",
                discoveryBatchId: "batch-sync-5",
                metadata: {
                    artistName: "Artist Five",
                    albumTitle: "Album Five",
                    queueSyncMissingCount: 2,
                },
            },
        ]);

        mockLidarrService.isAlbumAvailableInSnapshot.mockImplementation(
            (_snapshot: any, mbid?: string) => mbid === "mbid-available"
        );

        const result = await simpleDownloadManager.syncWithLidarrQueue(snapshot);

        expect(result).toEqual({ cancelled: 2, errors: [] });
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-sync-1" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        queueSyncMissingCount: 0,
                        lastQueueSyncFound: expect.any(String),
                    }),
                }),
            })
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-sync-2" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        queueSyncMissingCount: 2,
                        lastQueueSyncCheck: expect.any(String),
                    }),
                }),
            })
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-sync-3" },
                data: expect.objectContaining({
                    lidarrRef: "dl-replacement-3",
                    metadata: expect.objectContaining({
                        previousDownloadId: "dl-missing-3",
                        replacementDetected: true,
                        queueSyncMissingCount: 0,
                    }),
                }),
            })
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-sync-4" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        queueSyncCompleted: true,
                    }),
                }),
            })
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-sync-5" },
                data: expect.objectContaining({
                    status: "failed",
                    lidarrRef: null,
                    metadata: expect.objectContaining({
                        queueSyncCancelled: true,
                        queueSyncMissingCount: 3,
                    }),
                }),
            })
        );
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-sync-5"
        );
    });

    it("syncWithLidarrQueue returns errors when update processing fails", async () => {
        const snapshot = {
            queue: new Map<string, any>(),
        } as any;

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-sync-fail",
                status: "processing",
                lidarrRef: "dl-missing",
                targetMbid: "mbid-fail",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                    queueSyncMissingCount: 2,
                },
            },
        ]);
        mockLidarrService.isAlbumAvailableInSnapshot.mockReturnValue(false);
        mockPrisma.downloadJob.update.mockRejectedValueOnce(
            new Error("write failed")
        );

        const result = await simpleDownloadManager.syncWithLidarrQueue(snapshot);

        expect(result).toEqual({ cancelled: 0, errors: ["write failed"] });
    });

    it("blocklistAndRetry and removeFromLidarrQueue clean up matching queue entries", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [{ id: 81, downloadId: "dl-cleanup-1" }],
            },
        });
        await (simpleDownloadManager as any).blocklistAndRetry("dl-cleanup-1", 777);
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr:8686/api/v1/queue/81?removeFromClient=true&blocklist=true&skipRedownload=false",
            expect.any(Object)
        );

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [{ id: 82, downloadId: "dl-cleanup-2" }],
            },
        });
        await (simpleDownloadManager as any).removeFromLidarrQueue("dl-cleanup-2");
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr:8686/api/v1/queue/82?removeFromClient=true&blocklist=true&skipRedownload=false",
            expect.any(Object)
        );
    });

    it("blocklistAndRetry skips queue delete when no matching download exists", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [{ id: 91, downloadId: "dl-not-match" }],
            },
        });

        await (simpleDownloadManager as any).blocklistAndRetry(
            "dl-missing",
            999
        );

        expect(mockAxiosDelete).not.toHaveBeenCalled();
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
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-lidarr-mbid",
            "lidarr-mbid-1",
            "Album",
            "Artist",
            700
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
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-lidarr-album",
            "mbid-miss",
            "Album",
            "Artist",
            991
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
        tx.downloadJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        tx.downloadJob.create.mockResolvedValueOnce({ id: "tracking-created-1" });
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-create-1",
            "mbid-create-1",
            "Album Create",
            "Artist Create",
            5001
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
            })
        );
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
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-complete-by-album-id",
            undefined,
            undefined,
            undefined,
            12345
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
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "old-download-id",
            undefined,
            undefined,
            undefined,
            undefined
        );

        expect(result.jobId).toBe("job-complete-prev-id");
    });

    it("onDownloadComplete returns empty result when no active job matches", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-no-match",
            "mbid-no-match",
            "Artist",
            "Album",
            101
        );

        expect(result).toEqual({});
        expect(mockNotificationService.notifyDownloadComplete).not.toHaveBeenCalled();
    });

    it("onImportFailed removes queue entry even when no matching job exists", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );
        mockAxiosGet.mockResolvedValueOnce({
            data: { records: [{ id: 90, downloadId: "dl-no-job" }] },
        });
        mockAxiosDelete.mockResolvedValueOnce({});

        const result = await simpleDownloadManager.onImportFailed(
            "dl-no-job",
            "Import failed"
        );

        expect(result).toEqual({ retried: false, failed: false });
        expect(mockAxiosDelete).toHaveBeenCalledWith(
            "http://lidarr:8686/api/v1/queue/90?removeFromClient=true&blocklist=true&skipRedownload=false",
            expect.any(Object)
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
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onImportFailed(
            "dl-repeat",
            "same failure repeated"
        );

        expect(result).toEqual({
            retried: false,
            failed: false,
            jobId: "job-repeat-failure",
        });
        expect(tx.downloadJob.update).not.toHaveBeenCalled();
        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it("tryNextAlbumFromArtist skips fallback for discovery jobs", async () => {
        const markSpy = jest
            .spyOn(simpleDownloadManager as any, "markJobExhausted")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-discovery-fallback-skip",
            });

        const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
            {
                id: "job-discovery-fallback-skip",
                discoveryBatchId: "batch-discovery",
                metadata: {
                    artistName: "Discovery Artist",
                    artistMbid: "artist-discovery",
                },
            },
            "discovery diversity"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-discovery-fallback-skip",
        });
        expect(markSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-discovery-fallback-skip" }),
            "discovery diversity"
        );
        markSpy.mockRestore();
    });

    it("tryNextAlbumFromArtist marks exhausted when Lidarr returns no albums", async () => {
        const markSpy = jest
            .spyOn(simpleDownloadManager as any, "markJobExhausted")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-no-lidarr-albums",
            });
        mockLidarrService.getArtistAlbums.mockResolvedValueOnce([]);

        const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
            {
                id: "job-no-lidarr-albums",
                targetMbid: "mbid-current",
                artistMbid: "artist-no-albums",
                metadata: {
                    artistName: "No Albums Artist",
                    artistMbid: "artist-no-albums",
                },
            },
            "no albums in lidarr"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-no-lidarr-albums",
        });
        expect(markSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-no-lidarr-albums" }),
            "no albums in lidarr"
        );
        markSpy.mockRestore();
    });

    it("tryNextAlbumFromArtist marks exhausted when all candidate albums were already tried", async () => {
        const markSpy = jest
            .spyOn(simpleDownloadManager as any, "markJobExhausted")
            .mockResolvedValue({
                retried: false,
                failed: true,
                jobId: "job-all-tried",
            });
        mockLidarrService.getArtistAlbums.mockResolvedValueOnce([
            {
                id: 12,
                title: "Already Tried Album",
                foreignAlbumId: "mbid-current",
                albumType: "album",
            },
        ] as any);
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);

        const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
            {
                id: "job-all-tried",
                targetMbid: "mbid-current",
                artistMbid: "artist-all-tried",
                userId: "user-all-tried",
                metadata: {
                    artistName: "All Tried Artist",
                    artistMbid: "artist-all-tried",
                },
            },
            "all albums exhausted"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-all-tried",
        });
        expect(markSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-all-tried" }),
            "all albums exhausted"
        );
        markSpy.mockRestore();
    });

    it("tryNextAlbumFromArtist returns failed when fallback job cannot start", async () => {
        const startSpy = jest
            .spyOn(simpleDownloadManager, "startDownload")
            .mockResolvedValue({
                success: false,
                error: "start failed",
            } as any);
        mockLidarrService.getArtistAlbums.mockResolvedValueOnce([
            {
                id: 77,
                title: "Fallback Album",
                foreignAlbumId: "mbid-fallback",
                albumType: "album",
            },
        ] as any);
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-fallback-start-fail",
        });

        const result = await (simpleDownloadManager as any).tryNextAlbumFromArtist(
            {
                id: "job-base-start-fail",
                userId: "user-base-start-fail",
                targetMbid: "mbid-original",
                artistMbid: "artist-fallback-fail",
                subject: "Artist - Original Album",
                metadata: {
                    artistName: "Artist",
                    artistMbid: "artist-fallback-fail",
                },
            },
            "retry different album"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-fallback-start-fail",
        });
        startSpy.mockRestore();
    });

    it("markJobExhausted suppresses notifications when policy blocks them", async () => {
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce({
            shouldNotify: false,
            reason: "notification cooldown",
        } as any);

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
            "all attempts exhausted"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-policy-blocked",
        });
        expect(mockNotificationService.notifyDownloadFailed).not.toHaveBeenCalled();
    });

    it("markJobExhausted continues when policy evaluation throws", async () => {
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);
        mockNotificationPolicyService.evaluateNotification.mockRejectedValueOnce(
            new Error("policy unavailable")
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
            "all attempts exhausted"
        );

        expect(result).toEqual({
            retried: false,
            failed: true,
            jobId: "job-policy-error",
        });
        expect(mockNotificationService.notifyDownloadFailed).not.toHaveBeenCalled();
    });

    it("markStaleJobsAsFailed extends timeout for active Lidarr downloads", async () => {
        const oldStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-stale-active-download",
                status: "processing",
                lidarrRef: "dl-active",
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                    startedAt: oldStartedAt,
                },
            },
        ]);
        mockLidarrService.isDownloadActiveInSnapshot.mockReturnValueOnce({
            active: true,
            progress: 63,
        } as any);

        const count = await simpleDownloadManager.markStaleJobsAsFailed({
            queue: new Map(),
        } as any);

        expect(count).toBe(0);
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-stale-active-download" },
                data: {
                    metadata: expect.objectContaining({
                        extendedTimeout: true,
                    }),
                },
            })
        );
    });

    it("markStaleJobsAsFailed handles policy timeout extension and duplicate-completion merge", async () => {
        const oldStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-policy-extend",
                status: "processing",
                lidarrRef: null,
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
                metadata: {
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    startedAt: oldStartedAt,
                },
            },
            {
                id: "job-duplicate-merge",
                status: "processing",
                lidarrRef: null,
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
                metadata: {
                    artistName: "Artist Two",
                    albumTitle: "Album Two",
                    startedAt: oldStartedAt,
                },
            },
        ]);
        mockNotificationPolicyService.evaluateNotification
            .mockResolvedValueOnce({
                shouldNotify: false,
                reason: "still in retry window, extending timeout",
            } as any)
            .mockRejectedValueOnce(new Error("policy failed"));
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-dup-completed",
            metadata: {
                artistName: "Artist Two",
                albumTitle: "Album Two",
            },
        });

        const count = await simpleDownloadManager.markStaleJobsAsFailed();

        expect(count).toBe(2);
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-policy-extend" },
                data: {
                    metadata: expect.objectContaining({
                        timeoutExtendedByPolicy: true,
                    }),
                },
            })
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-duplicate-merge" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        mergedWithJob: "job-dup-completed",
                    }),
                }),
            })
        );
    });

    it("markStaleJobsAsFailed starts same-artist fallback for library jobs and checks discovery completion", async () => {
        const oldStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValueOnce({
                retried: true,
                failed: false,
                jobId: "job-replacement-started",
            });
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-stale-library",
                status: "processing",
                lidarrRef: null,
                artistMbid: "artist-library",
                discoveryBatchId: null,
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
                metadata: {
                    artistName: "Artist Library",
                    albumTitle: "Album Library",
                    artistMbid: "artist-library",
                    startedAt: oldStartedAt,
                },
            },
            {
                id: "job-stale-discovery",
                status: "processing",
                lidarrRef: null,
                artistMbid: null,
                discoveryBatchId: "batch-stale-discovery",
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
                metadata: {
                    artistName: "Artist Discovery",
                    albumTitle: "Album Discovery",
                    startedAt: oldStartedAt,
                },
            },
        ]);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValue({
            shouldNotify: false,
            reason: "policy says no notification",
        } as any);
        mockPrisma.downloadJob.findFirst.mockResolvedValue(null);

        const count = await simpleDownloadManager.markStaleJobsAsFailed();

        expect(count).toBe(2);
        expect(fallbackSpy).toHaveBeenCalledTimes(1);
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-stale-library" }),
            "No sources found - no indexer results"
        );
        expect(
            mockPrisma.downloadJob.update.mock.calls.some(([args]: any) => {
                return (
                    args?.where?.id === "job-stale-library" &&
                    args?.data?.status === "failed"
                );
            })
        ).toBe(false);
        expect(
            mockPrisma.downloadJob.update.mock.calls.some(([args]: any) => {
                return (
                    args?.where?.id === "job-stale-discovery" &&
                    args?.data?.status === "failed"
                );
            })
        ).toBe(true);
        expect(mockDiscoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-stale-discovery"
        );
        fallbackSpy.mockRestore();
    });

    it("markStaleJobsAsFailed skips direct Soulseek sources from stale checks", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-soulseek-stale",
                status: "processing",
                lidarrRef: "dl-soulseek-stale",
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
                metadata: {
                    source: "soulseek_direct",
                    artistName: "Soulseek Artist",
                    albumTitle: "Soulseek Album",
                    startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
                },
            },
        ]);

        const count = await simpleDownloadManager.markStaleJobsAsFailed();

        expect(count).toBe(0);
        expect(mockPrisma.downloadJob.update).not.toHaveBeenCalled();
        expect(mockPrisma.downloadJob.updateMany).not.toHaveBeenCalled();
        expect(mockNotificationPolicyService.evaluateNotification).not.toHaveBeenCalled();
    });

    it("clearLidarrQueue returns configuration error when Lidarr settings are missing", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            musicPath: "/music-only",
        });

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result).toEqual({
            removed: 0,
            errors: ["Lidarr not configured"],
        });
    });

    it("clearLidarrQueue collects delete errors and tolerates search trigger failures", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 301,
                        albumId: 91,
                        status: "failed",
                        trackedDownloadStatus: "error",
                        trackedDownloadState: "importFailed",
                        statusMessages: [{ title: "failed", messages: ["oops"] }],
                        title: "Album 91",
                    },
                    {
                        id: 302,
                        albumId: 92,
                        status: "warning",
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                        statusMessages: [{ title: "warn", messages: ["retry"] }],
                        title: "Album 92",
                    },
                ],
            },
        });
        mockAxiosDelete
            .mockRejectedValueOnce(new Error("delete failed"))
            .mockResolvedValueOnce({});
        mockAxiosPost.mockRejectedValueOnce(new Error("search trigger failed"));

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result.removed).toBe(1);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain("Failed to remove 301");
    });

    it("clearLidarrQueue returns outer error when queue fetch fails", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("queue unavailable"));

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result).toEqual({
            removed: 0,
            errors: ["queue unavailable"],
        });
    });

    it("reconcileWithLidarr returns quickly when there are no processing jobs", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);

        const result = await simpleDownloadManager.reconcileWithLidarr({
            queue: new Map(),
        } as any);

        expect(result).toEqual({ reconciled: 0, errors: [] });
    });

    it("syncWithLidarrQueue returns quickly when there are no processing jobs", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([]);

        const result = await simpleDownloadManager.syncWithLidarrQueue({
            queue: new Map(),
        } as any);

        expect(result).toEqual({ cancelled: 0, errors: [] });
    });

    it("syncWithLidarrQueue skips processing when snapshot is unavailable", async () => {
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-sync-no-snapshot",
                status: "processing",
                lidarrRef: "dl-sync-no-snapshot",
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
            },
        ]);

        const result = await simpleDownloadManager.syncWithLidarrQueue(undefined);

        expect(result).toEqual({ cancelled: 0, errors: [] });
    });

    it("falls back to default retry attempts when user settings fetch fails", async () => {
        mockPrisma.userDiscoverConfig.findUnique.mockRejectedValueOnce(
            new Error("db down")
        );

        const attempts = await (simpleDownloadManager as any).getMaxAttempts(
            "user-fallback"
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
            "user-1"
        );

        expect(result.success).toBe(true);
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-1",
            "Artist",
            "Album",
            "/music-default",
            "artist-mbid-1",
            false
        );
    });

    it("continues startup when MusicBrainz artist lookup fails", async () => {
        mockMusicBrainzService.getReleaseGroup.mockRejectedValueOnce(
            new Error("musicbrainz timeout")
        );
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            metadata: { tier: "secondary" },
        });

        const result = await simpleDownloadManager.startDownload(
            "job-mb-fail",
            "Artist",
            "Album",
            "album-mbid-2",
            "user-1"
        );

        expect(result.success).toBe(true);
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "album-mbid-2",
            "Artist",
            "Album",
            "/music",
            undefined,
            false
        );
    });

    it("retries a transaction when Prisma reports serialization conflicts", async () => {
        const svc = simpleDownloadManager as any;
        let attempts = 0;
        const serializationError: any = new Error(
            "Could not serialize access due to concurrent transaction"
        );
        serializationError.code = "P2034";

        mockPrisma.$transaction.mockImplementation(
            async (operation: (tx: any) => Promise<any>) => {
                attempts++;
                if (attempts === 1) {
                    throw serializationError;
                }
                return operation(makeTx());
            }
        );

        const result = await svc.withTransaction(async () => {
            return "retried";
        }, { maxRetries: 2, logPrefix: "[SDM]" });

        expect(result).toBe("retried");
        expect(attempts).toBe(2);
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });
});
