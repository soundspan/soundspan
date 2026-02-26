import { Request, Response } from "express";
import fs from "fs";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: Request, _res: Response, next: () => void) => next(),
    apiLimiter: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
        },
        album: {
            findUnique: jest.fn(),
            update: jest.fn(),
            findMany: jest.fn(),
        },
        $queryRaw: jest.fn(),
    },
    Prisma: {
        SortOrder: {
            asc: "asc",
            desc: "desc",
        },
        DbNull: null,
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn(),
        getJob: jest.fn(),
    },
}));

jest.mock("../../workers/organizeSingles", () => ({
    organizeSingles: jest.fn(),
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {},
}));

jest.mock("../../services/fanart", () => ({
    fanartService: {},
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../../services/imageProvider", () => ({
    imageProviderService: {
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {},
}));

jest.mock("../../services/coverArt", () => ({
    coverArtService: {
        getCoverArt: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));

jest.mock("../../services/dataCache", () => ({
    dataCacheService: {},
}));

jest.mock("../../services/artistCountsService", () => ({
    backfillAllArtistCounts: jest.fn(),
    isBackfillNeeded: jest.fn(),
    getBackfillProgress: jest.fn(),
    isBackfillInProgress: jest.fn(),
}));

jest.mock("../../services/imageBackfill", () => ({
    isImageBackfillNeeded: jest.fn(),
    getImageBackfillProgress: jest.fn(),
    backfillAllImages: jest.fn(),
}));

jest.mock("../../utils/metadataOverrides", () => ({
    getMergedGenres: jest.fn(() => []),
    getArtistDisplaySummary: jest.fn(() => ""),
}));

jest.mock("../../utils/dateFilters", () => ({
    getEffectiveYear: jest.fn(),
    getDecadeWhereClause: jest.fn(),
    getDecadeFromYear: jest.fn(),
}));

jest.mock("../../utils/shuffle", () => ({
    shuffleArray: jest.fn((arr: unknown[]) => arr),
}));

jest.mock("../../utils/colorExtractor", () => ({
    extractColorsFromImage: jest.fn(async () => ({
        vibrant: "#000000",
        darkVibrant: "#000000",
        lightVibrant: "#000000",
        muted: "#000000",
        darkMuted: "#000000",
        lightMuted: "#000000",
    })),
}));

jest.mock("../../services/imageProxy", () => ({
    fetchExternalImage: jest.fn(),
    normalizeExternalImageUrl: (rawUrl: string) => {
        try {
            const parsed = new URL(rawUrl);
            const hostname = parsed.hostname.toLowerCase();
            if (
                parsed.protocol !== "http:" &&
                parsed.protocol !== "https:"
            ) {
                return null;
            }
            if (
                hostname === "localhost" ||
                hostname === "127.0.0.1" ||
                hostname.startsWith("192.168.")
            ) {
                return null;
            }
            return parsed.toString();
        } catch {
            return null;
        }
    },
}));

jest.mock("../../services/imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

import router from "../library";
import { redisClient } from "../../utils/redis";
import { fetchExternalImage } from "../../services/imageProxy";
import { coverArtService } from "../../services/coverArt";
import { prisma } from "../../utils/db";
import { deezerService } from "../../services/deezer";
import { imageProviderService } from "../../services/imageProvider";
import { downloadAndStoreImage } from "../../services/imageStorage";
import { getSystemSettings } from "../../utils/systemSettings";
import {
    backfillAllArtistCounts,
    getBackfillProgress,
    isBackfillInProgress,
    isBackfillNeeded,
} from "../../services/artistCountsService";
import {
    backfillAllImages,
    getImageBackfillProgress,
    isImageBackfillNeeded,
} from "../../services/imageBackfill";
import {
    getDecadeFromYear,
    getEffectiveYear,
} from "../../utils/dateFilters";

const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockFetchExternalImage = fetchExternalImage as jest.Mock;
const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockArtistUpdateMany = prisma.artist.updateMany as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockDeezerCover = deezerService.getAlbumCover as jest.Mock;
const mockImageProviderGetAlbumCover =
    imageProviderService.getAlbumCover as jest.Mock;
const mockDownloadAndStoreImage = downloadAndStoreImage as jest.Mock;
const mockCoverArtGetCoverArt = coverArtService.getCoverArt as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockIsBackfillNeeded = isBackfillNeeded as jest.Mock;
const mockGetBackfillProgress = getBackfillProgress as jest.Mock;
const mockIsBackfillInProgress = isBackfillInProgress as jest.Mock;
const mockBackfillAllArtistCounts = backfillAllArtistCounts as jest.Mock;
const mockIsImageBackfillNeeded = isImageBackfillNeeded as jest.Mock;
const mockGetImageBackfillProgress = getImageBackfillProgress as jest.Mock;
const mockBackfillAllImages = backfillAllImages as jest.Mock;
const mockGetEffectiveYear = getEffectiveYear as jest.Mock;
const mockGetDecadeFromYear = getDecadeFromYear as jest.Mock;

function getGetHandler(path: string, stackIndex = 1) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
    }
    return layer.route.stack[stackIndex].handle;
}

function getPostHandler(path: string, stackIndex = 0) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.post
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
    }
    return layer.route.stack[stackIndex].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        send: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        sendFile: jest.fn(function (_path: string, _options?: unknown) {
            return res;
        }),
        redirect: jest.fn(function (url: string) {
            res.redirectedTo = url;
            return res;
        }),
        end: jest.fn(function () {
            return res;
        }),
        setHeader: jest.fn(function (key: string, value: string) {
            res.headers[key] = value;
            return res;
        }),
    };
    return res;
}

describe("library cover-art proxy compatibility", () => {
    const coverArtHandler = getGetHandler("/cover-art/:id?");
    const colorsHandler = getGetHandler("/cover-art-colors");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
        mockCoverArtGetCoverArt.mockResolvedValue(null);
        mockImageProviderGetAlbumCover.mockResolvedValue(null);
    });

    it("blocks invalid/private cover-art URLs", async () => {
        const req = {
            query: { url: "http://127.0.0.1/private.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid cover art URL" });
        expect(mockFetchExternalImage).not.toHaveBeenCalled();
    });

    it("serves cached not-found cover-art response without refetching", async () => {
        mockRedisGet.mockResolvedValue(JSON.stringify({ notFound: true }));
        const req = {
            query: { url: "https://example.com/missing.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });
        expect(mockFetchExternalImage).not.toHaveBeenCalled();
    });

    it("negative-caches cover-art 404 responses", async () => {
        mockFetchExternalImage.mockResolvedValue({
            ok: false,
            status: "not_found",
            url: "https://example.com/missing.jpg",
        });
        const req = {
            query: { url: "https://example.com/missing.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringMatching(/^cover-art:/),
            30 * 24 * 60 * 60,
            JSON.stringify({ notFound: true })
        );
    });

    it("applies 90-day cache headers for fetched cover-art images", async () => {
        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            buffer: Buffer.from("cover-bytes"),
            contentType: "image/jpeg",
            etag: "etag-123",
            url: "https://example.com/cover.jpg",
        });
        const req = {
            query: { url: "https://example.com/cover.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Cache-Control"]).toBe(
            "public, max-age=7776000, immutable"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringMatching(/^cover-art:/),
            90 * 24 * 60 * 60,
            expect.any(String)
        );
    });

    it("self-heals missing native query-url covers via Deezer fallback", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockResolvedValue({
            id: "album-123",
            title: "Example Album",
            artist: { name: "Example Artist" },
        });
        mockDeezerCover.mockResolvedValue("https://cdn.deezer.com/cover.jpg");
        mockDownloadAndStoreImage.mockResolvedValue(
            "native:albums/album-123.jpg"
        );

        const req = {
            query: { url: "native:albums/album-123.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "album-123" },
            select: {
                id: true,
                title: true,
                rgMbid: true,
                coverUrl: true,
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });
        expect(mockDeezerCover).toHaveBeenCalledWith(
            "Example Artist",
            "Example Album"
        );
        expect(mockDownloadAndStoreImage).toHaveBeenCalledWith(
            "https://cdn.deezer.com/cover.jpg",
            "album-123",
            "album"
        );
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-123" },
            data: { coverUrl: "native:albums/album-123.jpg" },
        });
        expect(res.redirect).toHaveBeenCalledWith(
            "/api/library/cover-art?url=native%3Aalbums%2Falbum-123.jpg"
        );

        existsSpy.mockRestore();
    });

    it("self-heals missing native query-url covers via cover-art service when Deezer misses", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockResolvedValue({
            id: "album-456",
            title: "Fallback Album",
            rgMbid: "rg-456",
            artist: { name: "Fallback Artist" },
        });
        mockCoverArtGetCoverArt.mockResolvedValue(
            "https://coverartarchive.org/release-group/rg-456/front.jpg"
        );
        mockDeezerCover.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(
            "native:albums/album-456.jpg"
        );

        const req = {
            query: { url: "native:albums/album-456.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockCoverArtGetCoverArt).toHaveBeenCalledWith("rg-456");
        expect(mockDownloadAndStoreImage).toHaveBeenCalledWith(
            "https://coverartarchive.org/release-group/rg-456/front.jpg",
            "album-456",
            "album"
        );
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-456" },
            data: { coverUrl: "native:albums/album-456.jpg" },
        });
        expect(res.redirect).toHaveBeenCalledWith(
            "/api/library/cover-art?url=native%3Aalbums%2Falbum-456.jpg"
        );

        existsSpy.mockRestore();
    });

    it("reuses already-healed native query-url covers without re-fetching Deezer", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        mockAlbumFindUnique.mockResolvedValue({
            id: "album-123",
            title: "Example Album",
            coverUrl: "native:albums/album-123.jpg",
            artist: { name: "Example Artist" },
        });

        const req = {
            query: { url: "native:missing-path.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockDeezerCover).not.toHaveBeenCalled();
        expect(mockDownloadAndStoreImage).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith(
            "/api/library/cover-art?url=native%3Aalbums%2Falbum-123.jpg"
        );
        existsSpy.mockRestore();
    });

    it("returns 404 when native query-url fallback album is missing", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockResolvedValue(null);

        const req = {
            query: { url: "native:albums/missing-album.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockDeezerCover).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });

        existsSpy.mockRestore();
    });

    it("returns 404 when native query-url fallback has no Deezer cover result", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockResolvedValue({
            id: "album-no-cover",
            title: "Album Without Cover",
            artist: { name: "No Cover Artist" },
        });
        mockDeezerCover.mockResolvedValue(null);

        const req = {
            query: { url: "native:albums/album-no-cover.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });
        expect(mockAlbumUpdate).not.toHaveBeenCalled();

        existsSpy.mockRestore();
    });

    it("returns 404 when native query-url fallback lookup throws", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockRejectedValue(new Error("query fallback failed"));

        const req = {
            query: { url: "native:albums/album-throw.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });

        existsSpy.mockRestore();
    });

    it("returns 404 when native query-url cover has no recoverable album id", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        const req = {
            query: { url: "native:" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockAlbumFindUnique).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });

        existsSpy.mockRestore();
    });

    it("self-heals missing native id covers via Deezer fallback", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockResolvedValue({
            id: "album-789",
            title: "Album Title",
            artist: { name: "Artist Name" },
        });
        mockDeezerCover.mockResolvedValue("https://cdn.deezer.com/album-789.jpg");
        mockDownloadAndStoreImage.mockResolvedValue(
            "native:albums/album-789.jpg"
        );

        const req = {
            query: {},
            params: { id: "native:albums/album-789.jpg" },
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "album-789" },
            select: {
                id: true,
                title: true,
                rgMbid: true,
                coverUrl: true,
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-789" },
            data: { coverUrl: "native:albums/album-789.jpg" },
        });
        expect(res.redirect).toHaveBeenCalledWith(
            "/api/library/cover-art?url=native%3Aalbums%2Falbum-789.jpg"
        );

        existsSpy.mockRestore();
    });

    it("returns 404 when native id cover fallback lookup throws", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);
        mockAlbumFindUnique.mockRejectedValue(new Error("database unavailable"));

        const req = {
            query: {},
            params: { id: "native:albums/album-err.jpg" },
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });

        existsSpy.mockRestore();
    });

    it("blocks invalid/private color extraction URLs", async () => {
        const req = {
            query: { url: "http://127.0.0.1/private.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await colorsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid image URL" });
        expect(mockFetchExternalImage).not.toHaveBeenCalled();
    });

    it("returns gateway timeout for color fetch errors", async () => {
        mockFetchExternalImage.mockResolvedValue({
            ok: false,
            status: "fetch_error",
            message: "timeout",
            url: "https://example.com/cover.jpg",
        });
        const req = {
            query: { url: "https://example.com/cover.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await colorsHandler(req, res);

        expect(res.statusCode).toBe(504);
        expect(res.body).toEqual({ error: "Image fetch failed" });
    });

    it("fetches audiobook query-url cover art with auth and streams bytes", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
            headers: { get: jest.fn().mockReturnValue("image/jpeg") },
        });
        (global as any).fetch = fetchMock;
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const req = {
            query: { url: "audiobook__items/abc123/cover" },
            params: {},
            headers: { origin: "https://app.example" },
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(fetchMock).toHaveBeenCalledWith(
            "https://audiobooks.example/api/items/abc123/cover",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer abs-key",
                }),
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
        expect(res.headers["Content-Type"]).toBe("image/jpeg");
        expect(res.headers["Cache-Control"]).toBe(
            "public, max-age=7776000, immutable"
        );
    });

    it("returns 404 when audiobook query-url fetch fails", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: "Not Found",
            headers: { get: jest.fn().mockReturnValue(null) },
        });
        (global as any).fetch = fetchMock;
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const req = {
            query: { url: "audiobook__items/missing/cover" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Audiobook cover art not found" });
    });

    it("serves native query and id cover files with CORS headers", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);

        const queryReq = {
            query: { url: "native:albums/native-query.jpg" },
            params: {},
            headers: { origin: "https://frontend.example" },
        } as any;
        const queryRes = createRes();
        await coverArtHandler(queryReq, queryRes);
        expect(queryRes.sendFile).toHaveBeenCalledWith(
            "/tmp/covers/albums/native-query.jpg",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "Access-Control-Allow-Origin": "https://frontend.example",
                    "Access-Control-Allow-Credentials": "true",
                }),
            }),
        );

        const idReq = {
            query: {},
            params: { id: "native:albums/native-id.jpg" },
            headers: {},
        } as any;
        const idRes = createRes();
        await coverArtHandler(idReq, idRes);
        expect(idRes.sendFile).toHaveBeenCalledWith(
            "/tmp/covers/albums/native-id.jpg",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "Access-Control-Allow-Origin": "*",
                }),
            }),
        );

        existsSpy.mockRestore();
    });

    it("handles audiobook id covers and invalid id formats", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer,
            headers: { get: jest.fn().mockReturnValue("image/png") },
        });
        (global as any).fetch = fetchMock;
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const audiobookReq = {
            query: {},
            params: { id: "audiobook__items/id-cover" },
            headers: {},
        } as any;
        const audiobookRes = createRes();
        await coverArtHandler(audiobookReq, audiobookRes);
        expect(audiobookRes.statusCode).toBe(200);
        expect(audiobookRes.send).toHaveBeenCalledWith(expect.any(Buffer));

        const invalidReq = {
            query: {},
            params: { id: "not-a-valid-cover-id" },
            headers: {},
        } as any;
        const invalidRes = createRes();
        await coverArtHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid cover ID format" });
    });

    it("returns 404 when audiobook id cover fetch fails", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: "Not Found",
            headers: { get: jest.fn().mockReturnValue(null) },
        });
        (global as any).fetch = fetchMock;
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const audiobookReq = {
            query: {},
            params: { id: "audiobook__items/missing-id" },
            headers: {},
        } as any;
        const audiobookRes = createRes();

        await coverArtHandler(audiobookReq, audiobookRes);

        expect(fetchMock).toHaveBeenCalledWith(
            "https://audiobooks.example/api/items/missing-id",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer abs-key",
                }),
            }),
        );
        expect(audiobookRes.statusCode).toBe(404);
        expect(audiobookRes.body).toEqual({
            error: "Audiobook cover art not found",
        });
    });

    it("serves cached image bytes and handles cache read/write failures", async () => {
        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify({
                etag: "etag-cached",
                contentType: "image/webp",
                data: Buffer.from("cached-image").toString("base64"),
            })
        );
        const cachedReq = {
            query: { url: "https://example.com/cached.webp" },
            params: {},
            headers: {},
        } as any;
        const cachedRes = createRes();
        await coverArtHandler(cachedReq, cachedRes);
        expect(cachedRes.statusCode).toBe(200);
        expect(cachedRes.headers["Content-Type"]).toBe("image/webp");
        expect(cachedRes.headers["ETag"]).toBe("etag-cached");
        expect(cachedRes.send).toHaveBeenCalledWith(expect.any(Buffer));

        mockRedisGet.mockRejectedValueOnce(new Error("redis unavailable"));
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "not_found",
            url: "https://example.com/missing.jpg",
        });
        mockRedisSetEx.mockRejectedValueOnce(new Error("write failed"));
        const notFoundReq = {
            query: { url: "https://example.com/missing.jpg" },
            params: {},
            headers: {},
        } as any;
        const notFoundRes = createRes();
        await coverArtHandler(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Cover art not found" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            buffer: Buffer.from("fresh-image"),
            contentType: "image/jpeg",
            etag: "etag-fresh",
            url: "https://example.com/fresh.jpg",
        });
        mockRedisSetEx.mockRejectedValueOnce(new Error("write failed"));
        const freshReq = {
            query: { url: "https://example.com/fresh.jpg" },
            params: {},
            headers: { "if-none-match": "etag-fresh" },
        } as any;
        const freshRes = createRes();
        await coverArtHandler(freshReq, freshRes);
        expect(freshRes.statusCode).toBe(304);
    });

    it("refetches cover-art when the cached payload is malformed", async () => {
        mockRedisGet.mockResolvedValueOnce("not valid json");
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            buffer: Buffer.from("recovered-by-refetch"),
            contentType: "image/png",
            etag: "etag-refetch",
            url: "https://example.com/recovered.jpg",
        });

        const req = {
            query: { url: "https://example.com/recovered.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(mockFetchExternalImage).toHaveBeenCalledWith({
            url: "https://example.com/recovered.jpg",
            timeoutMs: 15000,
            maxRetries: 3,
        });
        expect(res.statusCode).toBe(200);
        expect(res.send).toHaveBeenCalledWith(
            Buffer.from("recovered-by-refetch")
        );
        expect(res.headers["Cache-Control"]).toBe(
            "public, max-age=7776000, immutable"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringMatching(/^cover-art:/),
            90 * 24 * 60 * 60,
            expect.any(String)
        );
    });

    it("returns 500 when cover-art fetch throws unexpectedly", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockRejectedValueOnce(new Error("explode"));
        const req = {
            query: { url: "https://example.com/explode.jpg" },
            params: {},
            headers: {},
        } as any;
        const res = createRes();

        await coverArtHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fetch cover art" });
    });
});

describe("library policy and backfill compatibility", () => {
    const deletePolicyHandler = getGetHandler("/delete-policy", 0);
    const artistCountsStatusHandler = getGetHandler("/artist-counts/status", 0);
    const artistCountsBackfillHandler = getPostHandler(
        "/artist-counts/backfill"
    );
    const imageBackfillStatusHandler = getGetHandler(
        "/image-backfill/status",
        0
    );
    const imageBackfillStartHandler = getPostHandler("/image-backfill/start");
    const genresBackfillHandler = getPostHandler("/backfill-genres");

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: true,
        });
        mockIsBackfillNeeded.mockResolvedValue(true);
        mockGetBackfillProgress.mockResolvedValue({
            inProgress: false,
            processed: 0,
            total: 0,
        });
        mockIsBackfillInProgress.mockReturnValue(false);
        mockBackfillAllArtistCounts.mockReturnValue(Promise.resolve());
        mockIsImageBackfillNeeded.mockResolvedValue({
            needsBackfill: false,
        });
        mockGetImageBackfillProgress.mockReturnValue({
            inProgress: false,
            processed: 0,
            total: 0,
        });
        mockBackfillAllImages.mockReturnValue(Promise.resolve());
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistUpdateMany.mockResolvedValue({ count: 0 });
    });

    it("returns non-admin delete policy without consulting settings", async () => {
        const req = { user: { role: "user" } } as any;
        const res = createRes();

        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            isAdmin: false,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
        expect(mockGetSystemSettings).not.toHaveBeenCalled();
    });

    it("returns admin delete policy based on system settings", async () => {
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: false,
        });
        const req = { user: { role: "admin" } } as any;
        const res = createRes();

        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            isAdmin: true,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
    });

    it("returns artist-counts status with progress payload", async () => {
        mockIsBackfillNeeded.mockResolvedValue(false);
        mockGetBackfillProgress.mockResolvedValue({
            inProgress: true,
            processed: 13,
            total: 40,
        });
        const req = {} as any;
        const res = createRes();

        await artistCountsStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            needsBackfill: false,
            inProgress: true,
            processed: 13,
            total: 40,
        });
    });

    it("returns 500 when artist-counts status lookup fails", async () => {
        mockIsBackfillNeeded.mockRejectedValue(new Error("redis-down"));
        const req = {} as any;
        const res = createRes();

        await artistCountsStatusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to check status" });
    });

    it("returns processing when artist-counts backfill is already running", async () => {
        mockIsBackfillInProgress.mockReturnValue(true);
        const req = {} as any;
        const res = createRes();

        await artistCountsBackfillHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Backfill already in progress",
            status: "processing",
        });
        expect(mockBackfillAllArtistCounts).not.toHaveBeenCalled();
    });

    it("starts artist-counts backfill asynchronously", async () => {
        const req = {} as any;
        const res = createRes();

        await artistCountsBackfillHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Backfill started",
            status: "processing",
        });
        expect(mockBackfillAllArtistCounts).toHaveBeenCalledWith(
            expect.any(Function)
        );
    });

    it("returns image-backfill status payload", async () => {
        mockIsImageBackfillNeeded.mockResolvedValue({
            needsBackfill: true,
            missingArtistImages: 5,
        });
        mockGetImageBackfillProgress.mockReturnValue({
            inProgress: false,
            processed: 21,
            total: 50,
        });
        const req = {} as any;
        const res = createRes();

        await imageBackfillStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            needsBackfill: true,
            missingArtistImages: 5,
            inProgress: false,
            processed: 21,
            total: 50,
        });
    });

    it("returns processing with progress when image-backfill is already running", async () => {
        mockGetImageBackfillProgress.mockReturnValue({
            inProgress: true,
            processed: 14,
            total: 100,
        });
        const req = {} as any;
        const res = createRes();

        await imageBackfillStartHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Image backfill already in progress",
            status: "processing",
            progress: {
                inProgress: true,
                processed: 14,
                total: 100,
            },
        });
        expect(mockBackfillAllImages).not.toHaveBeenCalled();
    });

    it("starts image-backfill asynchronously", async () => {
        const req = {} as any;
        const res = createRes();

        await imageBackfillStartHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Image backfill started",
            status: "processing",
        });
        expect(mockBackfillAllImages).toHaveBeenCalledTimes(1);
    });

    it("returns no-op when no artists need genre backfill", async () => {
        mockArtistFindMany.mockResolvedValueOnce([]);

        const req = {} as any;
        const res = createRes();

        await genresBackfillHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "No artists need genre backfill",
            count: 0,
        });
        expect(mockArtistUpdateMany).not.toHaveBeenCalled();
    });

    it("resets matching artists for genre enrichment", async () => {
        mockArtistFindMany.mockResolvedValueOnce([
            { id: "artist-1", name: "Artist One", mbid: null },
            { id: "artist-2", name: "Artist Two", mbid: "mbid-2" },
        ]);
        mockArtistUpdateMany.mockResolvedValueOnce({ count: 2 });

        const req = {} as any;
        const res = createRes();

        await genresBackfillHandler(req, res);

        expect(mockArtistUpdateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["artist-1", "artist-2"] },
            },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Reset 2 artists for genre enrichment",
            count: 2,
            artists: ["Artist One", "Artist Two"],
        });
    });

    it("returns 500 when genre backfill query fails", async () => {
        mockArtistFindMany.mockRejectedValueOnce(new Error("db unavailable"));

        const req = {} as any;
        const res = createRes();

        await genresBackfillHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to backfill genres" });
    });
});

describe("library discovery metadata compatibility", () => {
    const genresHandler = getGetHandler("/genres", 0);
    const decadesHandler = getGetHandler("/decades", 0);
    const radioHandler = getGetHandler("/radio", 0);

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindMany.mockResolvedValue([]);
        mockQueryRaw.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockGetEffectiveYear.mockImplementation(
            (album: { displayYear?: number | null; originalYear?: number | null; year?: number | null }) =>
                album.displayYear ?? album.originalYear ?? album.year ?? null
        );
        mockGetDecadeFromYear.mockImplementation(
            (year: number) => Math.floor(year / 10) * 10
        );
    });

    it("returns genres while filtering out genres that match artist names", async () => {
        mockArtistFindMany.mockResolvedValueOnce([
            { name: "Radiohead", normalizedName: "radiohead" },
        ]);
        mockQueryRaw.mockResolvedValueOnce([
            { genre: "radiohead", track_count: 42n },
            { genre: "ambient", track_count: 19n },
        ]);

        const req = {} as any;
        const res = createRes();
        await genresHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            genres: [{ genre: "ambient", count: 19 }],
        });
    });

    it("returns 500 when genre aggregation fails", async () => {
        mockArtistFindMany.mockRejectedValueOnce(new Error("db-unavailable"));

        const req = {} as any;
        const res = createRes();
        await genresHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get genres" });
    });

    it("returns sorted decades with minimum-track filtering", async () => {
        mockAlbumFindMany.mockResolvedValueOnce([
            { year: 1994, originalYear: null, displayYear: null, _count: { tracks: 9 } },
            { year: 1996, originalYear: null, displayYear: null, _count: { tracks: 7 } },
            { year: 2012, originalYear: null, displayYear: null, _count: { tracks: 20 } },
            { year: 1981, originalYear: null, displayYear: null, _count: { tracks: 4 } },
        ]);

        const req = {} as any;
        const res = createRes();
        await decadesHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            decades: [
                { decade: 2010, count: 20 },
                { decade: 1990, count: 16 },
            ],
        });
    });

    it("returns 400 when radio endpoint is called without a type", async () => {
        const req = { query: {}, user: { id: "user-1" } } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Radio type is required" });
    });
});

describe("library album-cover compatibility", () => {
    const albumCoverHandler = getGetHandler("/album-cover/:mbid");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns 400 for temporary MBIDs without requesting cover lookup", async () => {
        const req = {
            params: { mbid: "temp-artist-mbid" },
            headers: {},
        } as any;
        const res = createRes();

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Valid MBID required" });
        expect(mockCoverArtGetCoverArt).not.toHaveBeenCalled();
    });

    it("returns 204 when no cover art exists for a valid MBID", async () => {
        const req = {
            params: { mbid: "00000000-0000-0000-0000-000000000001" },
            headers: {},
        } as any;
        const res = createRes();
        mockCoverArtGetCoverArt.mockResolvedValueOnce(null);

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(204);
        expect(mockCoverArtGetCoverArt).toHaveBeenCalledWith(
            "00000000-0000-0000-0000-000000000001"
        );
        expect(res.body).toBeUndefined();
    });

    it("returns cover URL payload when cover art is available", async () => {
        const req = {
            params: { mbid: "00000000-0000-0000-0000-000000000002" },
            headers: {},
        } as any;
        const res = createRes();
        mockCoverArtGetCoverArt.mockResolvedValueOnce(
            "https://images.example/cover.jpg"
        );

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            coverUrl: "https://images.example/cover.jpg",
        });
        expect(mockCoverArtGetCoverArt).toHaveBeenCalledWith(
            "00000000-0000-0000-0000-000000000002"
        );
    });
});
