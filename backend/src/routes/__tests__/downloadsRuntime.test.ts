import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

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
            musicPath: "/music",
        },
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        isEnabled: jest.fn(),
        addArtist: jest.fn(),
        searchAlbum: jest.fn(),
        getAlbumReleases: jest.fn(),
        grabRelease: jest.fn(),
    },
}));

jest.mock("../../services/soulseek", () => ({
    soulseekService: {
        isAvailable: jest.fn(),
    },
}));

jest.mock("../../services/tidal", () => ({
    tidalService: {
        isAvailable: jest.fn(),
        findAlbum: jest.fn(),
        downloadAlbum: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        getArtist: jest.fn(),
        getReleaseGroups: jest.fn(),
        getReleaseGroup: jest.fn(),
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistCorrection: jest.fn(),
    },
}));

jest.mock("../../services/simpleDownloadManager", () => ({
    simpleDownloadManager: {
        startDownload: jest.fn(),
        clearLidarrQueue: jest.fn(),
    },
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
            create: jest.fn(),
        },
        unavailableAlbum: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            delete: jest.fn(),
        },
        discoveryTrack: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        album: {
            findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
        $queryRaw: jest.fn(),
    },
}));

import router from "../downloads";
import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { lidarrService } from "../../services/lidarr";
import { soulseekService } from "../../services/soulseek";
import { tidalService } from "../../services/tidal";
import { musicBrainzService } from "../../services/musicbrainz";
import { lastFmService } from "../../services/lastfm";
import { simpleDownloadManager } from "../../services/simpleDownloadManager";
import { scanQueue } from "../../workers/queues";

const mockGetSystemSettings = getSystemSettings as jest.Mock;

const mockLidarrIsEnabled = lidarrService.isEnabled as jest.Mock;
const mockLidarrAddArtist = lidarrService.addArtist as jest.Mock;
const mockLidarrGrabRelease = lidarrService.grabRelease as jest.Mock;

const mockSoulseekAvailable = soulseekService.isAvailable as jest.Mock;
const mockTidalAvailable = tidalService.isAvailable as jest.Mock;
const mockTidalFindAlbum = tidalService.findAlbum as jest.Mock;
const mockTidalDownloadAlbum = tidalService.downloadAlbum as jest.Mock;

const mockGetArtist = musicBrainzService.getArtist as jest.Mock;
const mockGetReleaseGroups = musicBrainzService.getReleaseGroups as jest.Mock;
const mockGetArtistCorrection = lastFmService.getArtistCorrection as jest.Mock;

const mockStartDownload = simpleDownloadManager.startDownload as jest.Mock;
const mockClearLidarrQueue =
    simpleDownloadManager.clearLidarrQueue as jest.Mock;
const mockScanQueueAdd = scanQueue.add as jest.Mock;

const mockDownloadFindUnique = prisma.downloadJob.findUnique as jest.Mock;
const mockDownloadFindMany = prisma.downloadJob.findMany as jest.Mock;
const mockDownloadFindFirst = prisma.downloadJob.findFirst as jest.Mock;
const mockDownloadUpdate = prisma.downloadJob.update as jest.Mock;
const mockDownloadDeleteMany = prisma.downloadJob.deleteMany as jest.Mock;
const mockDownloadCreate = prisma.downloadJob.create as jest.Mock;

const mockUnavailableFindMany = prisma.unavailableAlbum.findMany as jest.Mock;
const mockUnavailableFindFirst = prisma.unavailableAlbum.findFirst as jest.Mock;
const mockUnavailableDelete = prisma.unavailableAlbum.delete as jest.Mock;

const mockDiscoveryFindUnique = prisma.discoveryTrack.findUnique as jest.Mock;
const mockDiscoveryUpdate = prisma.discoveryTrack.update as jest.Mock;
const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
const mockTransaction = prisma.$transaction as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "delete" | "patch",
    stackIndex = 0
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[stackIndex].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

describe("downloads routes runtime", () => {
    const availabilityHandler = getRouteHandler("/availability", "get");
    const createJobHandler = getRouteHandler("/", "post");
    const clearAllHandler = getRouteHandler("/clear-all", "delete");
    const clearLidarrQueueHandler = getRouteHandler(
        "/clear-lidarr-queue",
        "post"
    );
    const failedListHandler = getRouteHandler("/failed", "get");
    const failedDismissHandler = getRouteHandler("/failed/:id", "delete");
    const grabHandler = getRouteHandler("/grab", "post");
    const getJobHandler = getRouteHandler("/:id", "get");
    const patchJobHandler = getRouteHandler("/:id", "patch");
    const deleteJobHandler = getRouteHandler("/:id", "delete");
    const listJobsHandler = getRouteHandler("/", "get");
    const keepTrackHandler = getRouteHandler("/keep-track", "post");

    beforeEach(() => {
        jest.clearAllMocks();

        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
        });

        mockLidarrIsEnabled.mockResolvedValue(true);
        mockLidarrAddArtist.mockResolvedValue({ id: 101 });
        mockLidarrGrabRelease.mockResolvedValue(true);

        mockSoulseekAvailable.mockResolvedValue(true);
        mockTidalAvailable.mockResolvedValue(false);
        mockTidalFindAlbum.mockResolvedValue(null);
        mockTidalDownloadAlbum.mockResolvedValue({
            downloaded: 0,
            failed: 0,
            total_tracks: 0,
            artist: "",
            album_title: "",
        });

        mockGetArtist.mockResolvedValue(null);
        mockGetReleaseGroups.mockResolvedValue([]);
        mockGetArtistCorrection.mockResolvedValue(null);

        mockDownloadFindUnique.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            metadata: {},
        });
        mockDownloadFindMany.mockResolvedValue([]);
        mockDownloadFindFirst.mockResolvedValue(null);
        mockDownloadUpdate.mockResolvedValue({});
        mockDownloadDeleteMany.mockResolvedValue({ count: 0 });
        mockDownloadCreate.mockResolvedValue({ id: "job-1", status: "pending" });

        mockUnavailableFindMany.mockResolvedValue([]);
        mockUnavailableFindFirst.mockResolvedValue(null);
        mockUnavailableDelete.mockResolvedValue({ id: "failed-1" });

        mockDiscoveryFindUnique.mockResolvedValue(null);
        mockDiscoveryUpdate.mockResolvedValue({});

        mockAlbumFindFirst.mockResolvedValue(null);

        mockStartDownload.mockResolvedValue({ success: true });
        mockClearLidarrQueue.mockResolvedValue({ removed: 2, errors: 0 });
        mockScanQueueAdd.mockResolvedValue(undefined);

        mockTransaction.mockImplementation(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest.fn().mockResolvedValue({
                        id: "job-1",
                        status: "pending",
                    }),
                },
            })
        );
    });

    it("returns service availability flags", async () => {
        mockLidarrIsEnabled.mockResolvedValue(false);
        mockSoulseekAvailable.mockResolvedValue(true);
        mockTidalAvailable.mockResolvedValue(false);

        const req = {} as any;
        const res = createRes();

        await availabilityHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            enabled: true,
            lidarr: false,
            soulseek: true,
            tidal: false,
        });
    });

    it("returns 500 when availability checks fail", async () => {
        mockLidarrIsEnabled.mockRejectedValueOnce(new Error("lidarr down"));

        const req = {} as any;
        const res = createRes();

        await availabilityHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to check download availability",
        });
    });

    it("returns 400 for missing create-job required fields", async () => {
        const req = {
            body: { type: "album", mbid: "rg-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Missing required fields: type, mbid, subject",
        });
    });

    it("returns 400 for invalid create-job type", async () => {
        const req = {
            body: { type: "track", mbid: "rg-1", subject: "Artist - Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Type must be 'artist' or 'album'" });
    });

    it("returns 400 for invalid create-job downloadType", async () => {
        const req = {
            body: {
                type: "album",
                mbid: "rg-1",
                subject: "Artist - Album",
                downloadType: "invalid",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "downloadType must be 'library' or 'discovery'",
        });
    });

    it("returns 400 when no download service is configured", async () => {
        mockLidarrIsEnabled.mockResolvedValue(false);
        mockSoulseekAvailable.mockResolvedValue(false);
        mockTidalAvailable.mockResolvedValue(false);

        const req = {
            body: { type: "album", mbid: "rg-1", subject: "Artist - Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "No download service configured. Please set up Lidarr, Soulseek, or TIDAL.",
        });
    });

    it("returns duplicate details when album job already exists in transaction", async () => {
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([
                    {
                        id: "existing-job",
                        status: "processing",
                        subject: "Artist - Album",
                        createdAt: new Date(),
                    },
                ]),
                downloadJob: {
                    create: jest.fn(),
                },
            })
        );

        const req = {
            body: {
                type: "album",
                mbid: "rg-1",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "existing-job",
                duplicate: true,
                message: "Download already in progress",
            })
        );
    });

    it("creates an album job and triggers simple download manager", async () => {
        mockGetArtistCorrection.mockResolvedValueOnce({
            corrected: true,
            canonicalName: "Correct Artist",
        });

        const createdJob = { id: "job-created", status: "pending" };

        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest.fn().mockResolvedValue(createdJob),
                },
            })
        );

        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-created",
            userId: "user-1",
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-1",
                subject: "Typo Artist - Album",
                artistName: "Typo Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await new Promise((resolve) => setImmediate(resolve));

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "job-created",
                status: "pending",
                message: "Download job created. Processing in background.",
            })
        );
        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-created",
            "Correct Artist",
            "Album",
            "rg-1",
            "user-1"
        );
    });

    it("returns existing active job for P2002 race-condition collisions", async () => {
        mockTransaction.mockRejectedValueOnce({ code: "P2002" });
        mockDownloadFindFirst.mockResolvedValueOnce({
            id: "race-job",
            status: "pending",
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-race",
                subject: "Artist - Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            id: "race-job",
            status: "pending",
            duplicate: true,
            message: "Download already in progress",
        });
    });

    it("creates artist batch response with discovery root folder", async () => {
        mockGetArtist.mockResolvedValueOnce({ name: "Artist Canonical" });
        mockGetReleaseGroups.mockResolvedValueOnce([]);

        const req = {
            body: {
                type: "artist",
                mbid: "artist-mbid-1",
                subject: "Alias Artist",
                downloadType: "discovery",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(mockLidarrAddArtist).toHaveBeenCalledWith(
            "artist-mbid-1",
            "Artist Canonical",
            "/music/discovery"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                status: "processing",
                downloadType: "discovery",
                rootFolderPath: "/music/discovery",
                albumCount: 0,
                jobs: [],
            })
        );
    });

    it("returns 500 when artist processing fails", async () => {
        mockLidarrAddArtist.mockResolvedValueOnce(null);

        const req = {
            body: {
                type: "artist",
                mbid: "artist-mbid-2",
                subject: "Artist Name",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to create download job" });
    });

    it("clears jobs for the current user with optional status filter", async () => {
        mockDownloadDeleteMany.mockResolvedValueOnce({ count: 3 });

        const req = {
            user: { id: "user-1" },
            query: { status: "failed" },
        } as any;
        const res = createRes();

        await clearAllHandler(req, res);

        expect(mockDownloadDeleteMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                status: "failed",
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, deleted: 3 });
    });

    it("returns 500 on user-scoped routes when auth context is missing", async () => {
        const req = { query: {} } as any;
        const res = createRes();

        await clearAllHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to clear downloads" });
    });

    it("clears Lidarr queue entries", async () => {
        mockClearLidarrQueue.mockResolvedValueOnce({ removed: 4, errors: 1 });

        const req = {} as any;
        const res = createRes();

        await clearLidarrQueueHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, removed: 4, errors: 1 });
    });

    it("returns 500 when clearing Lidarr queue fails", async () => {
        mockClearLidarrQueue.mockRejectedValueOnce(
            new Error("lidarr queue timeout")
        );

        const req = {} as any;
        const res = createRes();

        await clearLidarrQueueHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to clear Lidarr queue" });
    });

    it("lists failed albums for the current user", async () => {
        mockUnavailableFindMany.mockResolvedValueOnce([
            { id: "failed-1", userId: "user-1" },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await failedListHandler(req, res);

        expect(mockUnavailableFindMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            orderBy: { createdAt: "desc" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([{ id: "failed-1", userId: "user-1" }]);
    });

    it("returns 404 when dismissing a failed album not owned by user", async () => {
        mockUnavailableFindFirst.mockResolvedValueOnce(null);

        const req = {
            params: { id: "failed-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await failedDismissHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Failed album not found" });
    });

    it("dismisses an owned failed album", async () => {
        mockUnavailableFindFirst.mockResolvedValueOnce({
            id: "failed-1",
            userId: "user-1",
        });

        const req = {
            params: { id: "failed-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await failedDismissHandler(req, res);

        expect(mockUnavailableDelete).toHaveBeenCalledWith({
            where: { id: "failed-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });
    });

    it("validates required fields for interactive grab", async () => {
        const req = {
            body: {
                lidarrAlbumId: 10,
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Missing required fields: guid, lidarrAlbumId",
        });
    });

    it("returns 400 for grab when Lidarr is not configured", async () => {
        mockLidarrIsEnabled.mockResolvedValueOnce(false);

        const req = {
            body: {
                guid: "guid-1",
                lidarrAlbumId: 55,
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Lidarr not configured" });
    });

    it("returns duplicate grab payload when an active job already exists", async () => {
        mockDownloadFindFirst.mockResolvedValueOnce({
            id: "existing-job",
            status: "processing",
        });

        const req = {
            body: {
                guid: "guid-1",
                lidarrAlbumId: "42",
                albumMbid: " rg-42 ",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(mockDownloadFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { lidarrAlbumId: 42 },
                        { targetMbid: "rg-42" },
                    ],
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            duplicate: true,
            jobId: "existing-job",
            message: "Download already in progress for this album",
        });
    });

    it("marks grab job failed when Lidarr grab call fails", async () => {
        mockDownloadCreate.mockResolvedValueOnce({ id: "grab-job-1" });
        mockLidarrGrabRelease.mockResolvedValueOnce(false);

        const req = {
            body: {
                guid: "guid-1",
                indexerId: 12,
                lidarrAlbumId: 55,
                albumMbid: "rg-55",
                artistName: "Artist",
                albumTitle: "Album",
                title: "Release 1",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(mockDownloadUpdate).toHaveBeenCalledWith({
            where: { id: "grab-job-1" },
            data: expect.objectContaining({
                status: "failed",
                error: "Failed to grab release from indexer",
            }),
        });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to grab release" });
    });

    it("returns success payload when grab is accepted", async () => {
        mockDownloadCreate.mockResolvedValueOnce({ id: "grab-job-2" });
        mockLidarrGrabRelease.mockResolvedValueOnce(true);

        const req = {
            body: {
                guid: "guid-2",
                indexerId: 9,
                lidarrAlbumId: 77,
                albumMbid: "rg-77",
                artistName: "Artist",
                albumTitle: "Album",
                title: "Release 2",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            jobId: "grab-job-2",
            message: 'Downloading "Album" - release grabbed from indexer',
        });
    });

    it("returns 404 for unknown download job lookup", async () => {
        mockDownloadFindFirst.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-job" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await getJobHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Download job not found" });
    });

    it("returns a download job when lookup succeeds", async () => {
        mockDownloadFindFirst.mockResolvedValueOnce({
            id: "job-lookup",
            status: "processing",
            userId: "user-1",
        });

        const req = {
            params: { id: "job-lookup" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await getJobHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            id: "job-lookup",
            status: "processing",
            userId: "user-1",
        });
    });

    it("patches an existing job status and completion time", async () => {
        mockDownloadFindFirst.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
        });
        mockDownloadUpdate.mockResolvedValueOnce({
            id: "job-1",
            status: "completed",
        });

        const req = {
            params: { id: "job-1" },
            body: { status: "completed" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await patchJobHandler(req, res);

        expect(mockDownloadUpdate).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: expect.objectContaining({
                status: "completed",
                completedAt: expect.any(Date),
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ id: "job-1", status: "completed" });
    });

    it("deletes jobs idempotently via deleteMany", async () => {
        mockDownloadDeleteMany.mockResolvedValueOnce({ count: 0 });

        const req = {
            params: { id: "job-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await deleteJobHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, deleted: false });
    });

    it("lists jobs with default discovery filtering and cleared exclusion", async () => {
        mockDownloadFindMany.mockResolvedValueOnce([
            {
                id: "job-library",
                metadata: { downloadType: "library" },
            },
            {
                id: "job-discovery",
                metadata: { downloadType: "discovery" },
            },
        ]);

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await listJobsHandler(req, res);

        expect(mockDownloadFindMany).toHaveBeenCalledWith({
            where: { userId: "user-1", cleared: false },
            orderBy: { createdAt: "desc" },
            take: 50,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "job-library",
                metadata: { downloadType: "library" },
            },
        ]);
    });

    it("lists jobs with explicit includeCleared and includeDiscovery", async () => {
        mockDownloadFindMany.mockResolvedValueOnce([
            { id: "job-1", metadata: { downloadType: "library" } },
            { id: "job-2", metadata: { downloadType: "discovery" } },
        ]);

        const req = {
            query: {
                includeCleared: "true",
                includeDiscovery: "true",
                status: "processing",
                limit: "10",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await listJobsHandler(req, res);

        expect(mockDownloadFindMany).toHaveBeenCalledWith({
            where: { userId: "user-1", status: "processing" },
            orderBy: { createdAt: "desc" },
            take: 10,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveLength(2);
    });

    it("validates keep-track payload", async () => {
        const req = {
            body: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await keepTrackHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Missing discoveryTrackId" });
    });

    it("returns 404 when keep-track target is missing", async () => {
        mockDiscoveryFindUnique.mockResolvedValueOnce(null);

        const req = {
            body: { discoveryTrackId: "disc-track-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await keepTrackHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Discovery track not found" });
    });

    it("creates follow-up album download when keeping a track and Lidarr is enabled", async () => {
        mockDiscoveryFindUnique.mockResolvedValueOnce({
            id: "disc-track-1",
            discoveryAlbum: {
                albumTitle: "Discovery Album",
                artistName: "Discovery Artist",
                rgMbid: "rg-disc-1",
            },
        });
        mockLidarrIsEnabled.mockResolvedValueOnce(true);
        mockDownloadCreate.mockResolvedValueOnce({ id: "keep-job-1" });

        const req = {
            body: { discoveryTrackId: "disc-track-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await keepTrackHandler(req, res);

        expect(mockDiscoveryUpdate).toHaveBeenCalledWith({
            where: { id: "disc-track-1" },
            data: { userKept: true },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message:
                "Track marked as kept. Full album will be downloaded to permanent library.",
            downloadJobId: "keep-job-1",
        });
    });

    it("returns manual follow-up message when keeping a track without Lidarr", async () => {
        mockDiscoveryFindUnique.mockResolvedValueOnce({
            id: "disc-track-2",
            discoveryAlbum: {
                albumTitle: "Discovery Album",
                artistName: "Discovery Artist",
                rgMbid: "rg-disc-2",
            },
        });
        mockLidarrIsEnabled.mockResolvedValueOnce(false);

        const req = {
            body: { discoveryTrackId: "disc-track-2" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await keepTrackHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message:
                "Track marked as kept. Please add the full album manually to your /music folder.",
        });
    });

    it("creates artist batch jobs while skipping existing and queued albums", async () => {
        mockGetArtist.mockResolvedValueOnce({ name: "Artist Name" });
        mockGetReleaseGroups.mockResolvedValueOnce([
            { id: "rg-existing", title: "Existing Album" },
            { id: "rg-queued", title: "Queued Album" },
            { id: "rg-new", title: "New Album" },
        ]);
        mockAlbumFindFirst
            .mockResolvedValueOnce({ id: "existing-album" })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockTransaction
            .mockImplementationOnce(async (callback: any) =>
                callback({
                    $queryRaw: jest.fn().mockResolvedValue([
                        {
                            id: "queued-job",
                            status: "pending",
                            subject: "Artist Name - Queued Album",
                            createdAt: new Date(),
                        },
                    ]),
                    downloadJob: {
                        create: jest.fn(),
                    },
                }),
            )
            .mockImplementationOnce(async (callback: any) =>
                callback({
                    $queryRaw: jest
                        .fn()
                        .mockResolvedValueOnce([])
                        .mockResolvedValueOnce([]),
                    downloadJob: {
                        create: jest
                            .fn()
                            .mockResolvedValue({ id: "job-new", status: "pending" }),
                    },
                }),
            );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-new",
            userId: "user-1",
            metadata: {},
        });

        const req = {
            body: {
                type: "artist",
                mbid: "artist-mbid-3",
                subject: "Artist Name",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                albumCount: 1,
                jobs: [{ id: "job-new", subject: "Artist Name - New Album" }],
            }),
        );
        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-new",
            "Artist Name",
            "New Album",
            "rg-new",
            "user-1",
        );
    });

    it("skips recently failed artist albums without creating new jobs", async () => {
        mockGetReleaseGroups.mockResolvedValueOnce([
            { id: "rg-recent-fail", title: "Recently Failed" },
        ]);
        mockAlbumFindFirst.mockResolvedValueOnce(null);
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest
                    .fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([
                        {
                            id: "failed-job",
                            status: "failed",
                            completedAt: new Date(),
                        },
                    ]),
                downloadJob: {
                    create: jest.fn(),
                },
            }),
        );

        const req = {
            body: {
                type: "artist",
                mbid: "artist-mbid-4",
                subject: "Artist Name",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                albumCount: 0,
                jobs: [],
            }),
        );
        expect(mockStartDownload).not.toHaveBeenCalled();
    });

    it("returns 500 when listing failed albums throws", async () => {
        mockUnavailableFindMany.mockRejectedValueOnce(new Error("db unavailable"));

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await failedListHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to list failed albums" });
    });

    it("returns 500 when dismissing a failed album throws", async () => {
        mockUnavailableFindFirst.mockResolvedValueOnce({
            id: "failed-1",
            userId: "user-1",
        });
        mockUnavailableDelete.mockRejectedValueOnce(new Error("delete failed"));

        const req = {
            params: { id: "failed-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await failedDismissHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to delete failed album" });
    });

    it("ignores background album processing when job lookup misses", async () => {
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-missing", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce(null);

        const req = {
            body: {
                type: "album",
                mbid: "rg-missing-job",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(mockStartDownload).not.toHaveBeenCalled();
    });

    it("parses artist/album from subject when album metadata is missing", async () => {
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-parse", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-parse",
            userId: "user-1",
            metadata: {},
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-parse",
                subject: "SingleSubject",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-parse",
            "SingleSubject",
            "SingleSubject",
            "rg-parse",
            "user-1",
        );
    });

    it("parses artist/album split from subject when delimiter is present", async () => {
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-parse-split", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-parse-split",
            userId: "user-1",
            metadata: {},
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-parse-split",
                subject: "Split Artist - Split Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-parse-split",
            "Split Artist",
            "Split Album",
            "rg-parse-split",
            "user-1",
        );
    });

    it("logs failed simple download starts without crashing create job flow", async () => {
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-simple-fail", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-simple-fail",
            userId: "user-1",
            metadata: {},
        });
        mockStartDownload.mockResolvedValueOnce({
            success: false,
            error: "unavailable indexer",
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-simple-fail",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-simple-fail",
            "Artist",
            "Album",
            "rg-simple-fail",
            "user-1",
        );
    });

    it("handles background processor rejections from single album jobs", async () => {
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-throw", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-throw",
            userId: "user-1",
            metadata: {},
        });
        mockStartDownload.mockRejectedValueOnce(new Error("start threw"));

        const req = {
            body: {
                type: "album",
                mbid: "rg-throw",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
    });

    it("uses LastFM artist correction for artist downloads when MusicBrainz lookup fails", async () => {
        mockGetArtist.mockRejectedValueOnce(new Error("mb down"));
        mockGetArtistCorrection.mockResolvedValueOnce({
            canonicalName: "Artist Canonical",
        });
        mockGetReleaseGroups.mockResolvedValueOnce([]);

        const req = {
            body: {
                type: "artist",
                mbid: "artist-fallback-1",
                subject: "Alias Artist",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(mockLidarrAddArtist).toHaveBeenCalledWith(
            "artist-fallback-1",
            "Artist Canonical",
            "/music",
        );
    });

    it("keeps original artist name when MusicBrainz and LastFM corrections both fail", async () => {
        mockGetArtist.mockRejectedValueOnce(new Error("mb down"));
        mockGetArtistCorrection.mockRejectedValueOnce(new Error("lfm down"));
        mockGetReleaseGroups.mockResolvedValueOnce([]);

        const req = {
            body: {
                type: "artist",
                mbid: "artist-fallback-2",
                subject: "Alias Artist",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);

        expect(mockLidarrAddArtist).toHaveBeenCalledWith(
            "artist-fallback-2",
            "Alias Artist",
            "/music",
        );
    });

    it("logs per-album background failures during artist batch processing", async () => {
        mockGetReleaseGroups.mockResolvedValueOnce([
            { id: "rg-batch-1", title: "Batch Album" },
        ]);
        mockAlbumFindFirst.mockResolvedValueOnce(null);
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest
                    .fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-batch-1", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-batch-1",
            userId: "user-1",
            metadata: {},
        });
        mockStartDownload.mockRejectedValueOnce(new Error("batch failure"));

        const req = {
            body: {
                type: "artist",
                mbid: "artist-batch-fail",
                subject: "Batch Artist",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(mockStartDownload).toHaveBeenCalled();
    });

    it("falls back to soulseek when configured tidal source is unavailable", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(false);
        mockSoulseekAvailable.mockResolvedValue(true);
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-fallback-1", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-fallback-1",
            userId: "user-1",
            metadata: {},
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-fallback-1",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-fallback-1",
            "Artist",
            "Album",
            "rg-fallback-1",
            "user-1",
        );
    });

    it("falls back to tidal when configured soulseek source is unavailable", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(true);
        mockSoulseekAvailable.mockResolvedValue(false);
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockTidalFindAlbum.mockResolvedValueOnce({
            albumId: 789,
            title: "Album",
            artist: "Artist",
            numberOfTracks: 6,
        });
        mockTidalDownloadAlbum.mockResolvedValueOnce({
            downloaded: 6,
            failed: 0,
            total_tracks: 6,
            artist: "Artist",
            album_title: "Album",
        });
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-fallback-3", status: "pending" }),
                },
            }),
        );
        let findUniqueCall = 0;
        mockDownloadFindUnique.mockImplementation(async () => {
            findUniqueCall += 1;
            if (findUniqueCall === 1) {
                return {
                    id: "job-fallback-3",
                    userId: "user-1",
                    metadata: {},
                };
            }
            return {
                metadata: { albumMbid: "rg-fallback-3" },
            };
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-fallback-3",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockTidalFindAlbum).toHaveBeenCalledWith("Artist", "Album");
    });

    it("falls back to soulseek when configured lidarr source is unavailable", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "lidarr",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(false);
        mockSoulseekAvailable.mockResolvedValue(true);
        mockLidarrIsEnabled.mockResolvedValue(false);
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-fallback-2", status: "pending" }),
                },
            }),
        );
        mockDownloadFindUnique.mockResolvedValueOnce({
            id: "job-fallback-2",
            userId: "user-1",
            metadata: {},
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-fallback-2",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-fallback-2",
            "Artist",
            "Album",
            "rg-fallback-2",
            "user-1",
        );
    });

    it("completes tidal downloads and queues a library scan", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(true);
        mockTidalFindAlbum.mockResolvedValueOnce({
            albumId: 123,
            title: "Album",
            artist: "Artist",
            numberOfTracks: 10,
        });
        mockTidalDownloadAlbum.mockResolvedValueOnce({
            downloaded: 9,
            failed: 1,
            total_tracks: 10,
            artist: "Artist",
            album_title: "Album",
        });
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-tidal", status: "pending" }),
                },
            }),
        );
        let findUniqueCall = 0;
        mockDownloadFindUnique.mockImplementation(async () => {
            findUniqueCall += 1;
            if (findUniqueCall === 1) {
                return {
                    id: "job-tidal",
                    userId: "user-1",
                    metadata: {},
                };
            }
            return {
                metadata: { albumMbid: "rg-tidal" },
            };
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-tidal",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockTidalFindAlbum).toHaveBeenCalledWith("Artist", "Album");
        expect(mockTidalDownloadAlbum).toHaveBeenCalledWith(123);
        expect(mockScanQueueAdd).toHaveBeenCalledWith(
            "scan",
            expect.objectContaining({
                userId: "user-1",
                source: "tidal-download",
                artistName: "Artist",
                albumTitle: "Album",
            }),
        );
        expect(mockDownloadUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-tidal" },
                data: expect.objectContaining({
                    status: "completed",
                }),
            }),
        );
    });

    it("falls back when tidal cannot find album and reports fallback failures", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "tidal",
            primaryFailureFallback: "soulseek",
        });
        mockTidalAvailable.mockResolvedValue(true);
        mockTidalFindAlbum.mockResolvedValueOnce(null);
        mockStartDownload.mockResolvedValueOnce({
            success: false,
            error: "fallback failed",
        });
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-tidal-fallback", status: "pending" }),
                },
            }),
        );
        let findUniqueCall = 0;
        mockDownloadFindUnique.mockImplementation(async () => {
            findUniqueCall += 1;
            if (findUniqueCall === 1) {
                return {
                    id: "job-tidal-fallback",
                    userId: "user-1",
                    metadata: {},
                };
            }
            return {
                metadata: { albumMbid: "rg-fallback" },
            };
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-fallback",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-tidal-fallback",
            "Artist",
            "Album",
            "rg-fallback",
            "user-1",
        );
        expect(mockDownloadUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-tidal-fallback" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        currentSource: "soulseek",
                        statusText: "TIDAL not found → soulseek",
                    }),
                }),
            }),
        );
    });

    it("marks tidal jobs failed when album lookup misses and no fallback is configured", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(true);
        mockTidalFindAlbum.mockResolvedValueOnce(null);
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-tidal-fail", status: "pending" }),
                },
            }),
        );
        let findUniqueCall = 0;
        mockDownloadFindUnique.mockImplementation(async () => {
            findUniqueCall += 1;
            if (findUniqueCall === 1) {
                return {
                    id: "job-tidal-fail",
                    userId: "user-1",
                    metadata: {},
                };
            }
            return {
                metadata: {},
            };
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-tidal-fail",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockDownloadUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-tidal-fail" },
                data: expect.objectContaining({
                    status: "failed",
                    error: expect.stringContaining("Album not found on TIDAL"),
                }),
            }),
        );
    });

    it("marks tidal jobs failed when zero tracks download", async () => {
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(true);
        mockTidalFindAlbum.mockResolvedValueOnce({
            albumId: 456,
            title: "Album",
            artist: "Artist",
            numberOfTracks: 8,
        });
        mockTidalDownloadAlbum.mockResolvedValueOnce({
            downloaded: 0,
            failed: 8,
            total_tracks: 8,
            artist: "Artist",
            album_title: "Album",
        });
        mockTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ id: "job-tidal-zero", status: "pending" }),
                },
            }),
        );
        let findUniqueCall = 0;
        mockDownloadFindUnique.mockImplementation(async () => {
            findUniqueCall += 1;
            if (findUniqueCall === 1) {
                return {
                    id: "job-tidal-zero",
                    userId: "user-1",
                    metadata: {},
                };
            }
            return {
                metadata: {},
            };
        });

        const req = {
            body: {
                type: "album",
                mbid: "rg-tidal-zero",
                subject: "Artist - Album",
                artistName: "Artist",
                albumTitle: "Album",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await createJobHandler(req, res);
        await flushAsyncWork();

        expect(mockDownloadUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-tidal-zero" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "All 8 tracks failed to download",
                }),
            }),
        );
    });

    it("returns 500 when fetching a job throws", async () => {
        mockDownloadFindFirst.mockRejectedValueOnce(new Error("query failure"));

        const req = {
            params: { id: "job-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await getJobHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get download job" });
    });

    it("returns 404 when patch target does not exist", async () => {
        mockDownloadFindFirst.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing" },
            body: { status: "failed" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await patchJobHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Download job not found" });
    });

    it("returns 500 when patch update throws", async () => {
        mockDownloadFindFirst.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
        });
        mockDownloadUpdate.mockRejectedValueOnce(new Error("update failed"));

        const req = {
            params: { id: "job-1" },
            body: { status: "failed" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await patchJobHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update download job" });
    });

    it("returns 500 with error details when delete throws", async () => {
        mockDownloadDeleteMany.mockRejectedValueOnce(new Error("delete exploded"));

        const req = {
            params: { id: "job-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await deleteJobHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to delete download job",
            details: "delete exploded",
        });
    });

    it("returns 500 when listing jobs throws", async () => {
        mockDownloadFindMany.mockRejectedValueOnce(new Error("list failed"));

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await listJobsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to list download jobs" });
    });

    it("returns 500 when keep-track persistence fails", async () => {
        mockDiscoveryFindUnique.mockResolvedValueOnce({
            id: "disc-track-3",
            discoveryAlbum: {
                albumTitle: "Discovery Album",
                artistName: "Discovery Artist",
                rgMbid: "rg-disc-3",
            },
        });
        mockDiscoveryUpdate.mockRejectedValueOnce(new Error("update failed"));

        const req = {
            body: { discoveryTrackId: "disc-track-3" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await keepTrackHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to keep track" });
    });
});
