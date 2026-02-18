import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) => next(),
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
        getCalendar: jest.fn(),
        getMonitoredArtists: jest.fn(),
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
        album: {
            findMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
        $transaction: jest.fn(),
        $queryRaw: jest.fn(),
    },
}));

import downloadsRouter from "../downloads";
import releasesRouter from "../releases";
import { prisma } from "../../utils/db";
import { lidarrService } from "../../services/lidarr";

const mockDownloadFindMany = prisma.downloadJob.findMany as jest.Mock;
const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockGetCalendar = lidarrService.getCalendar as jest.Mock;
const mockGetMonitoredArtists = lidarrService.getMonitoredArtists as jest.Mock;

function getRouteHandler(
    router: any,
    path: string,
    method: "get" | "post" | "delete" | "patch",
    stackIndex = 0,
) {
    const layer = router.stack.find(
        (entry: any) =>
            entry.route?.path === path &&
            entry.route?.methods?.[method],
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

describe("downloads/release compatibility regressions", () => {
    const listDownloadsHandler = getRouteHandler(downloadsRouter, "/", "get");
    const radarHandler = getRouteHandler(releasesRouter, "/radar", "get");
    const upcomingHandler = getRouteHandler(releasesRouter, "/upcoming", "get");
    const recentHandler = getRouteHandler(releasesRouter, "/recent", "get");
    const downloadReleaseHandler = getRouteHandler(
        releasesRouter,
        "/download/:albumMbid",
        "post",
    );

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("filters discovery jobs out of downloads list by default", async () => {
        mockDownloadFindMany.mockResolvedValue([
            {
                id: "job-library",
                subject: "Owned Album",
                metadata: { downloadType: "library" },
                status: "completed",
            },
            {
                id: "job-discovery",
                subject: "Discovery Album",
                metadata: { downloadType: "discovery" },
                status: "completed",
            },
        ]);

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await listDownloadsHandler(req, res);

        expect(mockDownloadFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId: "user-1",
                    cleared: false,
                },
                take: 50,
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({ id: "job-library" }),
        ]);
    });

    it("includes discovery jobs when explicitly requested", async () => {
        mockDownloadFindMany.mockResolvedValue([
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
            query: { includeDiscovery: "true" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await listDownloadsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveLength(2);
    });

    it("classifies release radar status and downloadability correctly", async () => {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;

        mockGetCalendar.mockResolvedValue([
            {
                id: 1,
                title: "Future Release",
                artistName: "Artist One",
                artistMbid: "artist-1",
                albumMbid: "rg-future",
                releaseDate: new Date(now + oneDay).toISOString(),
                coverUrl: null,
                hasFile: false,
            },
            {
                id: 2,
                title: "Already Owned",
                artistName: "Artist Two",
                artistMbid: "artist-2",
                albumMbid: "rg-owned",
                releaseDate: new Date(now - oneDay).toISOString(),
                coverUrl: null,
                hasFile: false,
            },
            {
                id: 3,
                title: "Ready To Download",
                artistName: "Artist Three",
                artistMbid: "artist-3",
                albumMbid: "rg-missing",
                releaseDate: new Date(now - (2 * oneDay)).toISOString(),
                coverUrl: null,
                hasFile: false,
            },
        ]);
        mockGetMonitoredArtists.mockResolvedValue([{ mbid: "artist-1" }]);
        mockSimilarArtistFindMany.mockResolvedValue([
            {
                toArtist: {
                    id: "artist-9",
                    name: "Similar Unmonitored",
                    mbid: "artist-9",
                },
                weight: 0.9,
            },
            {
                toArtist: {
                    id: "artist-1",
                    name: "Already Monitored",
                    mbid: "artist-1",
                },
                weight: 0.8,
            },
        ]);
        mockAlbumFindMany.mockResolvedValue([{ rgMbid: "rg-owned" }]);

        const req = {
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await radarHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.monitoredArtistCount).toBe(1);
        expect(res.body.similarArtistCount).toBe(1);
        expect(res.body.upcoming).toEqual([
            expect.objectContaining({
                albumMbid: "rg-future",
                status: "upcoming",
                inLibrary: false,
                canDownload: false,
            }),
        ]);
        expect(res.body.recent).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumMbid: "rg-owned",
                    status: "available",
                    inLibrary: true,
                    canDownload: false,
                }),
                expect.objectContaining({
                    albumMbid: "rg-missing",
                    status: "released",
                    inLibrary: false,
                    canDownload: true,
                }),
            ]),
        );
    });

    it("requires authentication for release-radar download trigger", async () => {
        const req = {
            params: { albumMbid: "rg-abc" },
        } as any;
        const res = createRes();

        await downloadReleaseHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Authentication required" });
    });

    it("returns 501 for authenticated release-radar download trigger", async () => {
        const req = {
            params: { albumMbid: "rg-abc" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await downloadReleaseHandler(req, res);

        expect(res.statusCode).toBe(501);
        expect(res.body).toEqual({
            error: "Download feature not yet implemented for release radar",
        });
    });

    it("defaults upcoming days and returns releases in ascending order with count", async () => {
        const releases = [
            {
                id: 1,
                title: "Second",
                artistName: "Artist One",
                albumMbid: "rg-second",
                releaseDate: "2026-01-20T00:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: false,
                coverUrl: null,
            },
            {
                id: 2,
                title: "First",
                artistName: "Artist Two",
                albumMbid: "rg-first",
                releaseDate: "2026-01-10T00:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: false,
                coverUrl: null,
            },
            {
                id: 3,
                title: "Third",
                artistName: "Artist Three",
                albumMbid: "rg-third",
                releaseDate: "2026-01-15T00:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: false,
                coverUrl: null,
            },
        ];
        mockGetCalendar.mockResolvedValue(releases);

        const missingDaysRes = createRes();
        const invalidDaysRes = createRes();

        await upcomingHandler({ query: {} } as any, missingDaysRes);
        await upcomingHandler({ query: { days: "invalid" } } as any, invalidDaysRes);

        expect(mockGetCalendar).toHaveBeenCalledTimes(2);
        const dayMs = 24 * 60 * 60 * 1000;
        const [startOne, endOne] = mockGetCalendar.mock.calls[0] as [Date, Date];
        const [startTwo, endTwo] = mockGetCalendar.mock.calls[1] as [Date, Date];
        expect(Math.round((endOne.getTime() - startOne.getTime()) / dayMs)).toBe(90);
        expect(Math.round((endTwo.getTime() - startTwo.getTime()) / dayMs)).toBe(90);
        expect(missingDaysRes.statusCode).toBe(200);
        expect(invalidDaysRes.statusCode).toBe(200);
        expect(missingDaysRes.body).toMatchObject({
            count: 3,
            daysAhead: 90,
            releases: [
                expect.objectContaining({ albumMbid: "rg-first" }),
                expect.objectContaining({ albumMbid: "rg-third" }),
                expect.objectContaining({ albumMbid: "rg-second" }),
            ],
        });
        expect(invalidDaysRes.body).toMatchObject({
            daysAhead: 90,
            count: 3,
        });
    });

    it("returns 500 when upcoming calendar fetch fails", async () => {
        mockGetCalendar.mockRejectedValue(new Error("calendar failed"));

        const res = createRes();

        await upcomingHandler({ query: {} } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch upcoming releases",
        });
    });

    it("returns recent releases in descending order excluding downloaded and library matches", async () => {
        mockAlbumFindMany.mockResolvedValue([
            { rgMbid: "rg-library-match" },
            { rgMbid: "rg-old-library" },
        ]);
        mockGetCalendar.mockResolvedValue([
            {
                id: 4,
                title: "Older New",
                artistName: "Artist One",
                albumMbid: "rg-older-keep",
                releaseDate: "2025-12-31T00:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: false,
                coverUrl: null,
            },
            {
                id: 5,
                title: "Has File",
                artistName: "Artist Two",
                albumMbid: "rg-has-file",
                releaseDate: "2026-01-09T00:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: true,
                coverUrl: null,
            },
            {
                id: 6,
                title: "In Library",
                artistName: "Artist Three",
                albumMbid: "rg-library-match",
                releaseDate: "2026-01-08T00:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: false,
                coverUrl: null,
            },
            {
                id: 7,
                title: "Newest",
                artistName: "Artist Four",
                albumMbid: "rg-newest",
                releaseDate: "2026-01-09T12:00:00.000Z",
                monitored: false,
                grabbed: false,
                hasFile: false,
                coverUrl: null,
            },
        ]);

        const res = createRes();
        await recentHandler({ query: {} } as any, res);

        expect(mockAlbumFindMany).toHaveBeenCalledTimes(1);
        const dayMs = 24 * 60 * 60 * 1000;
        const [startDate, endDate] = mockGetCalendar.mock.calls[0] as [Date, Date];
        expect(Math.round((endDate.getTime() - startDate.getTime()) / dayMs)).toBe(30);
        expect(res.statusCode).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.inLibraryCount).toBe(2);
        expect(res.body.releases).toEqual([
            expect.objectContaining({ albumMbid: "rg-newest" }),
            expect.objectContaining({ albumMbid: "rg-older-keep" }),
        ]);
        expect(res.body.releases.map((r: any) => r.albumMbid)).toEqual([
            "rg-newest",
            "rg-older-keep",
        ]);
    });

    it("returns 500 when recent calendar fetch fails", async () => {
        mockGetCalendar.mockRejectedValue(new Error("calendar failed"));

        const res = createRes();

        await recentHandler({ query: {} } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch recent releases",
        });
    });
});
