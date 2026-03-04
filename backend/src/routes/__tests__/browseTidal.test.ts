import type { NextFunction, Request, Response } from "express";
import request from "supertest";

// ── Auth mock: header-gated so we can test 401 explicitly ───────
const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, res: Response, next: NextFunction) => {
        if (req.header(AUTH_HEADER) !== AUTH_VALUE) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = {
            id: "user-1",
            username: "tester",
            role: "user",
        };
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ── Stub out dependencies that browse.ts imports but we don't need ──
jest.mock("../../services/spotify", () => ({
    spotifyService: { parseUrl: jest.fn() },
}));
jest.mock("../../services/deezer", () => ({
    deezerService: { parseUrl: jest.fn() },
}));
jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService: {},
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

// ── TIDAL streaming service mock ────────────────────────────────
const tidalStreamingService = {
    isEnabled: jest.fn(),
    isAvailable: jest.fn(),
    getAuthStatus: jest.fn(),
    getUserPreferredQuality: jest.fn(),
    getHomeShelves: jest.fn(),
    getExploreShelves: jest.fn(),
    getGenres: jest.fn(),
    getMoods: jest.fn(),
    getMixes: jest.fn(),
    getGenrePlaylists: jest.fn(),
    getBrowsePlaylist: jest.fn(),
    getBrowseMix: jest.fn(),
};
jest.mock("../../services/tidalStreaming", () => ({
    tidalStreamingService,
}));

// ── Browse image cache — stub to avoid disk I/O ─────────────────
jest.mock("../../services/browseImageCache", () => ({
    browseImageCacheKey: jest.fn((url: string) => `hash:${url}`),
    getBrowseImageFromCache: jest.fn(),
    fetchAndCacheBrowseImage: jest.fn(),
}));

import router, { _resetTidalBrowseCache } from "../browse";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/browse", router);

// ── Fixtures ────────────────────────────────────────────────────

const SHELF_FIXTURE = [
    {
        title: "Featured Playlists",
        contents: [
            {
                type: "playlist",
                playlistId: "abc-123",
                title: "Top Hits",
                thumbnailUrl: "https://resources.tidal.com/images/abc.jpg",
                subtitle: "Updated weekly",
            },
        ],
    },
];

const GENRE_FIXTURE = [
    {
        name: "Pop",
        path: "Pop",
        hasPlaylists: true,
        imageUrl: "https://resources.tidal.com/images/pop.jpg",
    },
    {
        name: "Rock",
        path: "Rock",
        hasPlaylists: true,
        imageUrl: null,
    },
];

const MOOD_FIXTURE = [
    {
        name: "Chill",
        path: "Chill",
        hasPlaylists: true,
        imageUrl: "https://resources.tidal.com/images/chill.jpg",
    },
];

const MIX_FIXTURE = [
    {
        mixId: "mix-001",
        title: "My Daily Discovery",
        subTitle: "A mix made for you",
        thumbnailUrl: "https://resources.tidal.com/images/mix.jpg",
    },
];

const GENRE_PLAYLISTS_FIXTURE = [
    {
        playlistId: "pl-pop-1",
        title: "Pop Hits",
        thumbnailUrl: "https://resources.tidal.com/images/pophits.jpg",
        numTracks: 50,
    },
];

const PLAYLIST_DETAIL_FIXTURE = {
    id: "pl-001",
    title: "Top Hits",
    trackCount: 2,
    thumbnailUrl: "https://resources.tidal.com/images/playlist.jpg",
    tracks: [
        {
            trackId: 12345,
            title: "Song One",
            artist: "Artist A",
            artists: ["Artist A", "Artist B"],
            album: "Album X",
            duration: 210,
            isrc: "USRC17607839",
            thumbnailUrl: "https://resources.tidal.com/images/song1.jpg",
        },
        {
            trackId: 67890,
            title: "Song Two",
            artist: "Artist C",
            artists: ["Artist C"],
            album: "Album Y",
            duration: 185,
            isrc: null,
            thumbnailUrl: null,
        },
    ],
};

const MIX_DETAIL_FIXTURE = {
    id: "mix-001",
    title: "My Daily Discovery",
    trackCount: 1,
    thumbnailUrl: "https://resources.tidal.com/images/mix.jpg",
    tracks: [
        {
            trackId: 11111,
            title: "Mix Track",
            artist: "Mix Artist",
            artists: ["Mix Artist"],
            album: "Mix Album",
            duration: 240,
            isrc: "GBDVX1100012",
            thumbnailUrl: null,
        },
    ],
};

// ── Tests ───────────────────────────────────────────────────────

describe("browse tidal routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetTidalBrowseCache();
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
        tidalStreamingService.isEnabled.mockResolvedValue(true);
        tidalStreamingService.isAvailable.mockResolvedValue(true);
        tidalStreamingService.getAuthStatus.mockResolvedValue({ authenticated: true });
        tidalStreamingService.getUserPreferredQuality.mockResolvedValue("HIGH");
    });

    // ── 1. Image proxy host validation ──────────────────────────

    describe("GET /api/browse/tidal/image", () => {
        it("proxies images from resources.tidal.com (200)", async () => {
            const { fetchAndCacheBrowseImage } =
                require("../../services/browseImageCache") as any;
            fetchAndCacheBrowseImage.mockResolvedValueOnce({
                filePath: "/tmp/test.img",
                contentType: "image/jpeg",
            });

            const res = await request(app)
                .get(
                    "/api/browse/tidal/image?url=https://resources.tidal.com/images/abc.jpg"
                )
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
        });

        it("blocks disallowed hosts with 400", async () => {
            const res = await request(app)
                .get(
                    "/api/browse/tidal/image?url=https://evil.example.com/bad.jpg"
                )
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
            expect(res.body).toEqual(
                expect.objectContaining({ error: expect.stringContaining("not allowed") })
            );
        });

        it("returns 400 when URL param is missing", async () => {
            const res = await request(app)
                .get("/api/browse/tidal/image")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
            expect(res.body).toEqual(
                expect.objectContaining({ error: expect.any(String) })
            );
        });
    });

    // ── 2. 403 when TIDAL not enabled ───────────────────────────

    describe("403 when TIDAL is not enabled", () => {
        beforeEach(() => {
            tidalStreamingService.isEnabled.mockResolvedValue(false);
        });

        const tidalBrowseRoutes = [
            "/api/browse/tidal/home",
            "/api/browse/tidal/explore",
            "/api/browse/tidal/genres",
            "/api/browse/tidal/moods",
            "/api/browse/tidal/mixes",
            "/api/browse/tidal/genre-playlists?path=Pop",
            "/api/browse/tidal/playlist/pl-001",
            "/api/browse/tidal/mix/mix-001",
        ] as const;

        for (const route of tidalBrowseRoutes) {
            it(`returns 403 for ${route}`, async () => {
                const res = await request(app)
                    .get(route)
                    .set(AUTH_HEADER, AUTH_VALUE);

                expect(res.status).toBe(403);
                expect(res.body).toEqual(
                    expect.objectContaining({
                        error: expect.stringContaining("TIDAL"),
                    })
                );
            });
        }
    });

    // ── 3. Browse routes return correct shapes ──────────────────

    describe("GET /api/browse/tidal/home", () => {
        it("returns shelves with source tidal", async () => {
            tidalStreamingService.getHomeShelves.mockResolvedValueOnce(
                SHELF_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/home")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                shelves: SHELF_FIXTURE,
                source: "tidal",
            });
            expect(tidalStreamingService.getHomeShelves).toHaveBeenCalledWith(
                "user-1", "HIGH"
            );
        });
    });

    describe("GET /api/browse/tidal/explore", () => {
        it("returns shelves with source tidal", async () => {
            tidalStreamingService.getExploreShelves.mockResolvedValueOnce(
                SHELF_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/explore")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                shelves: SHELF_FIXTURE,
                source: "tidal",
            });
            expect(
                tidalStreamingService.getExploreShelves
            ).toHaveBeenCalledWith("user-1", "HIGH");
        });
    });

    describe("GET /api/browse/tidal/genres", () => {
        it("returns genres with source tidal", async () => {
            tidalStreamingService.getGenres.mockResolvedValueOnce(
                GENRE_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/genres")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                genres: GENRE_FIXTURE,
                source: "tidal",
            });
            expect(tidalStreamingService.getGenres).toHaveBeenCalledWith(
                "user-1", "HIGH"
            );
        });
    });

    describe("GET /api/browse/tidal/moods", () => {
        it("returns moods with source tidal", async () => {
            tidalStreamingService.getMoods.mockResolvedValueOnce(MOOD_FIXTURE);

            const res = await request(app)
                .get("/api/browse/tidal/moods")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                moods: MOOD_FIXTURE,
                source: "tidal",
            });
            expect(tidalStreamingService.getMoods).toHaveBeenCalledWith(
                "user-1", "HIGH"
            );
        });
    });

    describe("GET /api/browse/tidal/mixes", () => {
        it("returns mixes with source tidal", async () => {
            tidalStreamingService.getMixes.mockResolvedValueOnce(MIX_FIXTURE);

            const res = await request(app)
                .get("/api/browse/tidal/mixes")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                mixes: MIX_FIXTURE,
                source: "tidal",
            });
            expect(tidalStreamingService.getMixes).toHaveBeenCalledWith(
                "user-1", "HIGH"
            );
        });
    });

    describe("GET /api/browse/tidal/genre-playlists", () => {
        it("returns playlists for a given genre path", async () => {
            tidalStreamingService.getGenrePlaylists.mockResolvedValueOnce(
                GENRE_PLAYLISTS_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/genre-playlists?path=Pop")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                playlists: GENRE_PLAYLISTS_FIXTURE,
                source: "tidal",
            });
            expect(
                tidalStreamingService.getGenrePlaylists
            ).toHaveBeenCalledWith("user-1", "Pop", "HIGH");
        });

        it("returns 400 when path query param is missing", async () => {
            const res = await request(app)
                .get("/api/browse/tidal/genre-playlists")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(400);
            expect(res.body).toEqual(
                expect.objectContaining({ error: expect.any(String) })
            );
        });
    });

    describe("GET /api/browse/tidal/playlist/:id", () => {
        it("returns playlist detail with tracks", async () => {
            tidalStreamingService.getBrowsePlaylist.mockResolvedValueOnce(
                PLAYLIST_DETAIL_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/playlist/pl-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                ...PLAYLIST_DETAIL_FIXTURE,
                source: "tidal",
            });
            expect(
                tidalStreamingService.getBrowsePlaylist
            ).toHaveBeenCalledWith("user-1", "pl-001", "HIGH", undefined);
        });

        it("forwards optional limit parameter", async () => {
            tidalStreamingService.getBrowsePlaylist.mockResolvedValueOnce(
                PLAYLIST_DETAIL_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/playlist/pl-001?limit=50")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(
                tidalStreamingService.getBrowsePlaylist
            ).toHaveBeenCalledWith("user-1", "pl-001", "HIGH", 50);
        });
    });

    describe("GET /api/browse/tidal/mix/:id", () => {
        it("returns mix detail with tracks", async () => {
            tidalStreamingService.getBrowseMix.mockResolvedValueOnce(
                MIX_DETAIL_FIXTURE
            );

            const res = await request(app)
                .get("/api/browse/tidal/mix/mix-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                ...MIX_DETAIL_FIXTURE,
                source: "tidal",
            });
            expect(tidalStreamingService.getBrowseMix).toHaveBeenCalledWith(
                "user-1",
                "mix-001",
                "HIGH"
            );
        });
    });

    // ── 4. Caching behavior ─────────────────────────────────────

    describe("caching", () => {
        it("second call to /tidal/home returns cached data (service called once)", async () => {
            tidalStreamingService.getHomeShelves.mockResolvedValue(
                SHELF_FIXTURE
            );

            const first = await request(app)
                .get("/api/browse/tidal/home")
                .set(AUTH_HEADER, AUTH_VALUE);

            const second = await request(app)
                .get("/api/browse/tidal/home")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(first.body).toEqual(second.body);
            expect(tidalStreamingService.getHomeShelves).toHaveBeenCalledTimes(
                1
            );
        });

        it("second call to /tidal/genres returns cached data (service called once)", async () => {
            tidalStreamingService.getGenres.mockResolvedValue(GENRE_FIXTURE);

            const first = await request(app)
                .get("/api/browse/tidal/genres")
                .set(AUTH_HEADER, AUTH_VALUE);

            const second = await request(app)
                .get("/api/browse/tidal/genres")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(first.body).toEqual(second.body);
            expect(tidalStreamingService.getGenres).toHaveBeenCalledTimes(1);
        });

        it("second call to /tidal/playlist/:id returns cached data (service called once)", async () => {
            tidalStreamingService.getBrowsePlaylist.mockResolvedValue(
                PLAYLIST_DETAIL_FIXTURE
            );

            const first = await request(app)
                .get("/api/browse/tidal/playlist/pl-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            const second = await request(app)
                .get("/api/browse/tidal/playlist/pl-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(first.body).toEqual(second.body);
            expect(
                tidalStreamingService.getBrowsePlaylist
            ).toHaveBeenCalledTimes(1);
        });

        it("second call to /tidal/mix/:id returns cached data (service called once)", async () => {
            tidalStreamingService.getBrowseMix.mockResolvedValue(
                MIX_DETAIL_FIXTURE
            );

            const first = await request(app)
                .get("/api/browse/tidal/mix/mix-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            const second = await request(app)
                .get("/api/browse/tidal/mix/mix-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(first.body).toEqual(second.body);
            expect(tidalStreamingService.getBrowseMix).toHaveBeenCalledTimes(1);
        });
    });

    // ── Auth gate ───────────────────────────────────────────────

    describe("401 when not authenticated", () => {
        it("returns 401 for /api/browse/tidal/home without auth header", async () => {
            const res = await request(app).get("/api/browse/tidal/home");

            expect(res.status).toBe(401);
            expect(res.body).toEqual(
                expect.objectContaining({ error: expect.any(String) })
            );
        });
    });

    // ── 500 on service errors ───────────────────────────────────

    describe("500 on service errors", () => {
        it("returns 500 when getHomeShelves throws", async () => {
            tidalStreamingService.getHomeShelves.mockRejectedValueOnce(
                new Error("sidecar down")
            );

            const res = await request(app)
                .get("/api/browse/tidal/home")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(500);
            expect(res.body).toEqual(
                expect.objectContaining({ error: expect.any(String) })
            );
        });

        it("returns 500 when getBrowsePlaylist throws", async () => {
            tidalStreamingService.getBrowsePlaylist.mockRejectedValueOnce(
                new Error("sidecar down")
            );

            const res = await request(app)
                .get("/api/browse/tidal/playlist/pl-001")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(500);
            expect(res.body).toEqual(
                expect.objectContaining({ error: expect.any(String) })
            );
        });
    });
});
