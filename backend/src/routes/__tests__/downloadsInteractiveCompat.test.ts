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
        searchAlbum: jest.fn(),
        addArtist: jest.fn(),
        getAlbumReleases: jest.fn(),
        grabRelease: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        getArtist: jest.fn(),
        getReleaseGroups: jest.fn(),
        getReleaseGroup: jest.fn(),
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

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
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
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
        $queryRaw: jest.fn(),
    },
}));

import downloadsRouter from "../downloads";
import { prisma } from "../../utils/db";
import { lidarrService } from "../../services/lidarr";
import { musicBrainzService } from "../../services/musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";

const mockLidarrIsEnabled = lidarrService.isEnabled as jest.Mock;
const mockLidarrSearchAlbum = lidarrService.searchAlbum as jest.Mock;
const mockLidarrAddArtist = lidarrService.addArtist as jest.Mock;
const mockLidarrGetAlbumReleases = lidarrService.getAlbumReleases as jest.Mock;
const mockLidarrGrabRelease = lidarrService.grabRelease as jest.Mock;
const mockGetReleaseGroup = musicBrainzService.getReleaseGroup as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockDownloadFindFirst = prisma.downloadJob.findFirst as jest.Mock;
const mockDownloadCreate = prisma.downloadJob.create as jest.Mock;
const mockDownloadUpdate = prisma.downloadJob.update as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "delete" | "patch",
    stackIndex = 0
) {
    const layer = (downloadsRouter as any).stack.find(
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

describe("downloads interactive release compatibility", () => {
    const releasesHandler = getRouteHandler("/releases/:albumMbid", "get");
    const grabHandler = getRouteHandler("/grab", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({ musicPath: "/music" });
        mockDownloadFindFirst.mockResolvedValue(null);
    });

    it("returns 400 when Lidarr is not configured for interactive releases", async () => {
        mockLidarrIsEnabled.mockResolvedValue(false);

        const req = {
            params: { albumMbid: "rg-1" },
            query: { artistName: "Artist", albumTitle: "Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Lidarr not configured" });
        expect(mockLidarrSearchAlbum).not.toHaveBeenCalled();
    });

    it("returns 400 when interactive release request is missing albumMbid", async () => {
        const req = {
            params: {},
            query: { artistName: "Artist", albumTitle: "Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Missing albumMbid parameter" });
    });

    it("returns 404 when album cannot be found in Lidarr even after artist add", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockLidarrSearchAlbum.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        mockGetReleaseGroup.mockResolvedValue({
            "artist-credit": [{ artist: { id: "artist-mbid-1" } }],
        });
        mockLidarrAddArtist.mockResolvedValue({ id: 123 });

        const req = {
            params: { albumMbid: "rg-1" },
            query: { artistName: "Artist", albumTitle: "Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(mockLidarrSearchAlbum).toHaveBeenCalledTimes(2);
        expect(mockLidarrAddArtist).toHaveBeenCalledWith(
            "artist-mbid-1",
            "Artist",
            "/music",
            false,
            false
        );
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Album not found in Lidarr",
            })
        );
    });

    it("returns formatted interactive releases when album lookup succeeds", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockLidarrSearchAlbum.mockResolvedValue([
            { id: 99, foreignAlbumId: "rg-1" },
        ]);
        mockLidarrGetAlbumReleases.mockResolvedValue([
            {
                guid: "guid-1",
                title: "Album 24bit FLAC",
                indexer: "Indexer One",
                indexerId: 42,
                size: 1073741824,
                seeders: 12,
                leechers: 2,
                protocol: "torrent",
                approved: true,
                rejected: false,
                rejections: [],
                quality: {
                    quality: { name: "FLAC" },
                },
            },
        ]);

        const req = {
            params: { albumMbid: "rg-1" },
            query: { artistName: "Artist", albumTitle: "Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(mockLidarrGetAlbumReleases).toHaveBeenCalledWith(99);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albumMbid: "rg-1",
            lidarrAlbumId: 99,
            releases: [
                expect.objectContaining({
                    guid: "guid-1",
                    title: "Album 24bit FLAC",
                    indexer: "Indexer One",
                    quality: "FLAC",
                    approved: true,
                    rejected: false,
                    rejections: [],
                    sizeFormatted: "1.00 GB",
                }),
            ],
            total: 1,
        });
    });

    it("returns releases when album is found after artist add retry", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockLidarrSearchAlbum
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 777, foreignAlbumId: "rg-retry" }]);
        mockGetReleaseGroup.mockResolvedValue({
            "artist-credit": [{ artist: { id: "artist-mbid-retry" } }],
        });
        mockLidarrAddArtist.mockResolvedValue({ id: 55 });
        mockLidarrGetAlbumReleases.mockResolvedValue([
            {
                guid: "guid-retry-1",
                title: "Retry Album Release",
                indexer: "Indexer",
                indexerId: 3,
                size: 512,
                seeders: 3,
                leechers: 1,
                protocol: "torrent",
                approved: true,
                rejected: false,
                rejections: [],
                quality: {
                    quality: { name: "FLAC" },
                },
            },
        ]);

        const req = {
            params: { albumMbid: "rg-retry" },
            query: { artistName: "Artist Retry", albumTitle: "Album Retry" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(mockLidarrSearchAlbum).toHaveBeenCalledTimes(2);
        expect(mockLidarrGetAlbumReleases).toHaveBeenCalledWith(777);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                albumMbid: "rg-retry",
                lidarrAlbumId: 777,
                total: 1,
            }),
        );
    });

    it("handles release-group lookup errors and still returns not-found response", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockLidarrSearchAlbum.mockResolvedValue([]);
        mockGetReleaseGroup.mockRejectedValue(new Error("musicbrainz timeout"));

        const req = {
            params: { albumMbid: "rg-mb-error" },
            query: { artistName: "Artist", albumTitle: "Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(mockLidarrAddArtist).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Album not found in Lidarr",
            }),
        );
    });

    it("returns 500 when interactive release lookup throws unexpectedly", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockLidarrSearchAlbum.mockRejectedValue(new Error("lidarr search exploded"));

        const req = {
            params: { albumMbid: "rg-throw" },
            query: { artistName: "Artist", albumTitle: "Album" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await releasesHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch releases",
            message: "lidarr search exploded",
        });
    });

    it("returns 400 when grab payload is missing required fields", async () => {
        const req = {
            body: { albumMbid: "rg-1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Missing required fields: guid, lidarrAlbumId",
        });
    });

    it("creates and returns a processing job when grabbing a release succeeds", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockDownloadCreate.mockResolvedValue({ id: "job-1" });
        mockLidarrGrabRelease.mockResolvedValue(true);

        const req = {
            body: {
                guid: "guid-1",
                indexerId: 42,
                albumMbid: "rg-1",
                lidarrAlbumId: 99,
                artistName: "Artist",
                albumTitle: "Album",
                title: "Album 24bit FLAC",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(mockDownloadFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: "user-1",
                    status: { in: ["pending", "processing"] },
                }),
            })
        );
        expect(mockDownloadCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: "user-1",
                    type: "album",
                    targetMbid: "rg-1",
                    status: "processing",
                    lidarrAlbumId: 99,
                    metadata: expect.objectContaining({
                        interactiveDownload: true,
                        selectedRelease: "Album 24bit FLAC",
                    }),
                }),
            })
        );
        expect(mockLidarrGrabRelease).toHaveBeenCalledWith(
            expect.objectContaining({
                guid: "guid-1",
                indexerId: 42,
                title: "Album 24bit FLAC",
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            jobId: "job-1",
            message: 'Downloading "Album" - release grabbed from indexer',
        });
    });

    it("deduplicates grab requests when an active album job already exists", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockDownloadFindFirst.mockResolvedValue({
            id: "job-existing",
            status: "processing",
        });

        const req = {
            body: {
                guid: "guid-dup",
                indexerId: 42,
                albumMbid: "rg-1",
                lidarrAlbumId: 99,
                artistName: "Artist",
                albumTitle: "Album",
                title: "Duplicate Candidate",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(mockDownloadCreate).not.toHaveBeenCalled();
        expect(mockLidarrGrabRelease).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            duplicate: true,
            jobId: "job-existing",
            message: "Download already in progress for this album",
        });
    });

    it("marks job failed and returns 500 when release grab fails", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockDownloadCreate.mockResolvedValue({ id: "job-2" });
        mockLidarrGrabRelease.mockResolvedValue(false);

        const req = {
            body: {
                guid: "guid-2",
                indexerId: 7,
                albumMbid: "rg-2",
                lidarrAlbumId: 101,
                artistName: "Artist",
                albumTitle: "Album",
                title: "Album WEB-DL",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(mockDownloadUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-2" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "Failed to grab release from indexer",
                }),
            })
        );
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to grab release" });
    });

    it("returns 500 when grab flow throws unexpectedly", async () => {
        mockLidarrIsEnabled.mockResolvedValue(true);
        mockDownloadCreate.mockRejectedValue(new Error("create failed"));

        const req = {
            body: {
                guid: "guid-3",
                indexerId: 99,
                albumMbid: "rg-3",
                lidarrAlbumId: 303,
                artistName: "Artist",
                albumTitle: "Album",
                title: "Release Throw",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await grabHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to grab release",
            message: "create failed",
        });
    });
});
