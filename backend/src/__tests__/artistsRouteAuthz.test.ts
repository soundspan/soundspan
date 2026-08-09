/**
 * Authorization contract for the artists router.
 *
 * The discovery/preview endpoints proxy external services (MusicBrainz,
 * Last.fm, Deezer, fanart.tv, YouTube Music) and must require
 * authentication. `requireAuthOrToken` is the guard because the preview
 * player builds token-authenticated stream URLs (`?token=`), matching the
 * existing /preview-stream/:videoId auth. All frontend callers go through
 * `frontend/lib/api.ts#request`, which always sends session cookies and/or
 * a Bearer token, so gating these does not break the preview player.
 */

export {};

const mockRequireAuthOrToken = jest.fn(async (req: any, res: any, next: any) => {
    if (req.headers["x-test-user"]) {
        req.user = { id: "user-1", username: "tester", role: "user" };
        return next();
    }
    return res.status(401).json({ error: "Not authenticated" });
});

jest.mock("../middleware/auth", () => ({
    requireAuthOrToken: (req: any, res: any, next: any) =>
        mockRequireAuthOrToken(req, res, next),
}));

jest.mock("../middleware/rateLimiter", () => ({
    ytMusicStreamLimiter: (_req: any, _res: any, next: any) => next(),
}));

const mockGetSystemSettings = jest.fn(async () => ({
    ytMusicEnabled: false,
}));

jest.mock("../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

jest.mock("../services/lastfm", () => ({
    lastFmService: {},
}));

jest.mock("../services/musicbrainz", () => ({
    musicBrainzService: {},
}));

jest.mock("../services/fanart", () => ({
    fanartService: {},
}));

jest.mock("../services/deezer", () => ({
    deezerService: {},
}));

jest.mock("../services/youtubeMusic", () => ({
    ytMusicService: {},
}));

jest.mock("../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async () => null),
        set: jest.fn(async () => undefined),
    },
}));

jest.mock("../utils/db", () => ({
    prisma: {
        userSettings: {
            findUnique: jest.fn(async () => null),
        },
    },
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import express from "express";
import request from "supertest";
import artistsRouter from "../routes/artists";

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/artists", artistsRouter);
    return app;
}

describe("artists router authorization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each([
        ["/api/artists/discover/Some%20Artist"],
        ["/api/artists/album/11111111-2222-4333-8444-555555555555"],
        ["/api/artists/preview/Some%20Artist/Some%20Track"],
        ["/api/artists/preview-stream/video-id"],
    ])("rejects unauthenticated requests to %s", async (path) => {
        const response = await request(buildApp()).get(path);
        expect(response.status).toBe(401);
    });

    it("reaches the preview handler when authenticated (404 with YT Music disabled)", async () => {
        const response = await request(buildApp())
            .get("/api/artists/preview/Some%20Artist/Some%20Track")
            .set("x-test-user", "yes");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Preview not found" });
    });

    it("passes authenticated requests to the discovery handlers", async () => {
        const discover = await request(buildApp())
            .get("/api/artists/discover/Some%20Artist")
            .set("x-test-user", "yes");
        const album = await request(buildApp())
            .get("/api/artists/album/11111111-2222-4333-8444-555555555555")
            .set("x-test-user", "yes");

        // Handlers hit mocked externals; the contract here is only that auth
        // no longer blocks the request (any non-401/403 outcome).
        expect([401, 403]).not.toContain(discover.status);
        expect([401, 403]).not.toContain(album.status);
    });
});
