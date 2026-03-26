import axios from "axios";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { prisma } from "../../utils/db";
import { lidarrService } from "../lidarr";
import { musicBrainzService } from "../musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { notificationPolicyService } from "../notificationPolicyService";
import { sessionLog } from "../../utils/playlistLogger";

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
const mockAxiosDelete = axios.delete as jest.Mock;
const mockPrisma = prisma as any;
const mockLidarrService = lidarrService as jest.Mocked<typeof lidarrService>;
const mockMusicBrainzService = musicBrainzService as jest.Mocked<
    typeof musicBrainzService
>;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockNotificationPolicyService =
    notificationPolicyService as jest.Mocked<typeof notificationPolicyService>;
const mockSessionLog = sessionLog as jest.Mock;

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

describe("simpleDownloadManager branch coverage", () => {
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

        mockLidarrService.addAlbum.mockResolvedValue({
            id: 77,
            foreignAlbumId: "album-mbid-1",
        } as any);
        mockLidarrService.getArtistAlbums.mockResolvedValue([]);
        mockLidarrService.isAlbumAvailableInSnapshot.mockReturnValue(false);
        mockLidarrService.isDownloadActiveInSnapshot.mockReturnValue({
            active: false,
            progress: 0,
        } as any);

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

        mockAxiosGet.mockResolvedValue({ data: { records: [] } });
        mockAxiosDelete.mockResolvedValue({});
    });

    it("uses default max attempts when user config returns 0", async () => {
        mockPrisma.userDiscoverConfig.findUnique.mockResolvedValueOnce({
            userId: "user-zero",
            maxRetryAttempts: 0,
        });

        const attempts = await (simpleDownloadManager as any).getMaxAttempts(
            "user-zero"
        );

        expect(attempts).toBe(3);
    });

    it("retries transaction when deadlock message is detected", async () => {
        const deadlockErr = new Error("deadlock detected while writing");
        mockPrisma.$transaction
            .mockRejectedValueOnce(deadlockErr)
            .mockImplementationOnce(
                async (operation: (tx: any) => Promise<any>) => operation(makeTx())
            );

        const timeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        const result = await (simpleDownloadManager as any).withTransaction(
            async () => "ok",
            { maxRetries: 2, logPrefix: "[TX-DEADLOCK]" }
        );

        expect(result).toBe("ok");
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
        timeoutSpy.mockRestore();
    });

    it("throws undefined when transaction retries are configured as zero", async () => {
        await expect(
            (simpleDownloadManager as any).withTransaction(async () => "never", {
                maxRetries: 0,
            })
        ).rejects.toBeUndefined();
    });

    it("continues startDownload when MusicBrainz release group has no artist id", async () => {
        mockMusicBrainzService.getReleaseGroup.mockResolvedValueOnce({
            "artist-credit": [{}],
        } as any);

        const result = await simpleDownloadManager.startDownload(
            "job-mb-no-artist",
            "Artist",
            "Album",
            "mbid-no-artist",
            "user-1"
        );

        expect(result.success).toBe(true);
        expect(mockLidarrService.addAlbum).toHaveBeenCalledWith(
            "mbid-no-artist",
            "Artist",
            "Album",
            "/music",
            undefined,
            false
        );
    });

    it("treats null Lidarr addAlbum result as album-not-found and succeeds via fallback", async () => {
        mockLidarrService.addAlbum.mockResolvedValueOnce(null as any);
        mockPrisma.downloadJob.findUnique.mockResolvedValueOnce({
            id: "job-null-result",
            discoveryBatchId: null,
            artistMbid: "artist-null-result",
            metadata: { artistMbid: "artist-null-result" },
        });

        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValueOnce({
                retried: true,
                failed: false,
                jobId: "job-fallback-null-result",
            });

        const result = await simpleDownloadManager.startDownload(
            "job-null-result",
            "Artist",
            "Album",
            "mbid-null-result",
            "user-1"
        );

        expect(result).toEqual({ success: true });
        expect(fallbackSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: "job-null-result" }),
            "Album not found in Lidarr"
        );
        fallbackSpy.mockRestore();
    });

    it("onDownloadComplete matches by metadata lidarrMbid fallback", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-complete-lidarr-mbid",
                userId: "user-complete-mbid",
                subject: "Artist MBID - Album MBID",
                status: "processing",
                lidarrRef: "another-id",
                targetMbid: "different-mbid",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist MBID",
                    albumTitle: "Album MBID",
                    lidarrMbid: "actual-lidarr-mbid",
                },
            },
        ]);
        tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-complete-lidarr-mbid",
            "actual-lidarr-mbid",
            undefined,
            undefined,
            undefined
        );

        expect(result.jobId).toBe("job-complete-lidarr-mbid");
    });

    it("onDownloadComplete matches by normalized artist+album metadata name", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-complete-name-meta",
                userId: "user-complete-name-meta",
                subject: "Totally Different Subject",
                status: "processing",
                lidarrRef: "another-id",
                targetMbid: "different-mbid",
                discoveryBatchId: null,
                metadata: {
                    artistName: "name artist",
                    albumTitle: "name album",
                },
            },
        ]);
        tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-complete-name",
            undefined,
            "Name Artist",
            "Name Album"
        );

        expect(result.jobId).toBe("job-complete-name-meta");
    });

    it("suppresses completion notification when policy blocks notify", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-no-notify",
                userId: "user-no-notify",
                subject: "Artist - Album",
                status: "processing",
                lidarrRef: "dl-no-notify",
                targetMbid: "mbid-no-notify",
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
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce({
            shouldNotify: false,
            reason: "cooldown active",
        } as any);

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-no-notify",
            "mbid-no-notify",
            "Artist",
            "Album"
        );

        expect(result.jobId).toBe("job-no-notify");
        expect(mockPrisma.downloadJob.update).not.toHaveBeenCalled();
    });

    it("logs spotify cleanup context and marks stale import as failed", async () => {
        const oldDate = new Date(Date.now() - 20 * 60 * 1000);
        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "spotify_stale_1",
                status: "processing",
                lidarrRef: "dl-stale-spotify",
                lidarrAlbumId: 1001,
                createdAt: oldDate,
                artistMbid: null,
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Spotify",
                    albumTitle: "Album Spotify",
                    startedAt: oldDate.toISOString(),
                },
            },
        ]);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce({
            shouldNotify: false,
            reason: "no timeout extension",
        } as any);
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);

        const result = await simpleDownloadManager.markStaleJobsAsFailed({
            queue: new Map(),
        } as any);

        expect(result).toBe(1);
        expect(mockSessionLog).toHaveBeenCalledWith(
            "CLEANUP",
            expect.stringContaining("Spotify import")
        );
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "spotify_stale_1" },
                data: expect.objectContaining({ status: "failed" }),
            })
        );
    });

    it("calls blocklistAndRetry for stale jobs that still have lidarr refs", async () => {
        const oldDate = new Date(Date.now() - 20 * 60 * 1000);
        const blocklistSpy = jest
            .spyOn(simpleDownloadManager as any, "blocklistAndRetry")
            .mockResolvedValue(undefined);
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockResolvedValue({ retried: false, failed: true, jobId: "x" });

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-stale-lidarr-ref",
                status: "processing",
                lidarrRef: "dl-stale-lidarr-ref",
                lidarrAlbumId: 501,
                createdAt: oldDate,
                artistMbid: "artist-ref",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Ref",
                    albumTitle: "Album Ref",
                    startedAt: oldDate.toISOString(),
                },
            },
        ]);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce({
            shouldNotify: false,
            reason: "timeout fail",
        } as any);
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);

        await simpleDownloadManager.markStaleJobsAsFailed({
            queue: new Map(),
        } as any);

        expect(blocklistSpy).toHaveBeenCalledWith("dl-stale-lidarr-ref", 501);
        blocklistSpy.mockRestore();
        fallbackSpy.mockRestore();
    });

    it("marks stale job failed when same-artist fallback throws", async () => {
        const oldDate = new Date(Date.now() - 20 * 60 * 1000);
        const fallbackSpy = jest
            .spyOn(simpleDownloadManager as any, "tryNextAlbumFromArtist")
            .mockRejectedValue(new Error("fallback crash"));

        mockPrisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-stale-fallback-throws",
                status: "processing",
                lidarrRef: null,
                createdAt: oldDate,
                artistMbid: "artist-throws",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Artist Throws",
                    albumTitle: "Album Throws",
                    batchId: "download-batch-throws",
                    startedAt: oldDate.toISOString(),
                },
            },
        ]);
        mockNotificationPolicyService.evaluateNotification.mockResolvedValueOnce({
            shouldNotify: false,
            reason: "no extension",
        } as any);
        mockPrisma.downloadJob.findFirst.mockResolvedValueOnce(null);

        const count = await simpleDownloadManager.markStaleJobsAsFailed();

        expect(count).toBe(1);
        expect(
            mockPrisma.downloadJob.update.mock.calls.some(([args]: any[]) => {
                return (
                    args?.where?.id === "job-stale-fallback-throws" &&
                    args?.data?.status === "failed"
                );
            })
        ).toBe(true);
        fallbackSpy.mockRestore();
    });

    it("blocklistAndRetry handles queue lookup errors", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("queue endpoint down"));

        await expect(
            (simpleDownloadManager as any).blocklistAndRetry("dl-queue-error", 77)
        ).resolves.toBeUndefined();
    });

    it("blocklistAndRetry handles settings failures", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(new Error("settings unavailable"));

        await expect(
            (simpleDownloadManager as any).blocklistAndRetry("dl-settings-error", 99)
        ).resolves.toBeUndefined();
    });

    it("removeFromLidarrQueue logs when queue item is not present", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: { records: [{ id: 1, downloadId: "not-this-one" }] },
        });

        await (simpleDownloadManager as any).removeFromLidarrQueue("missing-dl-id");

        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it("removeFromLidarrQueue swallows queue fetch errors", async () => {
        mockAxiosGet.mockRejectedValueOnce(new Error("queue fetch failed"));

        await expect(
            (simpleDownloadManager as any).removeFromLidarrQueue("dl-remove-fail")
        ).resolves.toBeUndefined();
    });

    it("clearLidarrQueue returns early when queue has zero records", async () => {
        mockAxiosGet.mockResolvedValueOnce({ data: { records: [] } });

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result).toEqual({ removed: 0, errors: [] });
    });

    it("clearLidarrQueue returns early when no records meet failed-item filters", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 800,
                        title: "Healthy item",
                        status: "downloading",
                        trackedDownloadStatus: "ok",
                        trackedDownloadState: "downloading",
                        statusMessages: [],
                    },
                ],
            },
        });

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result).toEqual({ removed: 0, errors: [] });
        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it("onDownloadGrabbed uses incoming MBID when matched job targetMbid is empty", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-empty-target",
                status: "pending",
                lidarrRef: null,
                targetMbid: "",
                metadata: {
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
            "dl-empty-target",
            "incoming-mbid",
            "Album",
            "Artist",
            88
        );

        expect(result).toEqual({ matched: true, jobId: "job-empty-target" });
        expect(tx.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ targetMbid: "incoming-mbid" }),
            })
        );
    });

    it("onDownloadGrabbed returns unmatched when duplicate exists by MBID", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "existing-mbid-job" });
        tx.downloadJob.findMany.mockResolvedValueOnce([]);
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-dup-mbid",
            "dup-mbid",
            "Album",
            "Artist",
            0
        );

        expect(result).toEqual({ matched: false });
    });

    it("onDownloadGrabbed checks name duplicates when album MBID is empty", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "recent-artist", userId: "user-non-mbid" });
        tx.downloadJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "name-dup",
                    status: "completed",
                    metadata: { artistName: "Artist", albumTitle: "Album" },
                },
            ]);
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadGrabbed(
            "dl-no-mbid",
            "",
            "Album",
            "Artist",
            0
        );

        expect(result).toEqual({ matched: false });
    });

    it("onDownloadComplete returns undefined batchId for completed jobs without discovery batch", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-complete-no-batch",
            discoveryBatchId: null,
            metadata: {},
        });
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete("dl-complete-no-batch");

        expect(result).toEqual({
            jobId: "job-complete-no-batch",
            batchId: undefined,
            downloadBatchId: undefined,
            spotifyImportJobId: undefined,
        });
    });

    it("onDownloadComplete can match by subject includes when metadata names differ", async () => {
        const tx = makeTx();
        tx.downloadJob.findFirst.mockResolvedValueOnce(null);
        tx.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-subject-match",
                userId: "user-subject-match",
                subject: "Subject Artist - Subject Album",
                status: "processing",
                lidarrRef: "different-ref",
                targetMbid: "different-mbid",
                discoveryBatchId: null,
                metadata: {
                    artistName: "Different Artist",
                    albumTitle: "Different Album",
                },
            },
        ]);
        tx.downloadJob.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.downloadJob.update.mockResolvedValueOnce({});
        mockPrisma.$transaction.mockImplementationOnce(
            async (operation: (tx: any) => Promise<any>) => operation(tx)
        );

        const result = await simpleDownloadManager.onDownloadComplete(
            "dl-subject-match",
            undefined,
            "Subject Artist",
            "Subject Album"
        );

        expect(result.jobId).toBe("job-subject-match");
    });

    it("blocklistAndRetry and removeFromLidarrQueue exit when Lidarr config is incomplete", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        await (simpleDownloadManager as any).blocklistAndRetry("dl-no-config", 10);

        mockGetSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        await (simpleDownloadManager as any).removeFromLidarrQueue("dl-no-config-2");

        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it("clearLidarrQueue handles mixed albumIds and non-Error rejection reasons", async () => {
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 901,
                        status: "failed",
                        trackedDownloadStatus: "error",
                        trackedDownloadState: "importFailed",
                        statusMessages: [{ title: "x", messages: ["y"] }],
                    },
                    {
                        id: 902,
                        albumId: 999,
                        status: "warning",
                        trackedDownloadStatus: "warning",
                        trackedDownloadState: "importPending",
                        statusMessages: [{ title: "x", messages: ["y"] }],
                        album: { title: "Album Title" },
                    },
                ],
            },
        });
        mockAxiosDelete.mockRejectedValueOnce("network").mockResolvedValueOnce({});

        const result = await simpleDownloadManager.clearLidarrQueue();

        expect(result.removed).toBe(1);
        expect(result.errors[0]).toContain("Unknown error");
    });
});
