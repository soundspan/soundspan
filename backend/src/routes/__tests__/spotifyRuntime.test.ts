jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const spotifyService = {
    parseUrl: jest.fn(),
};

jest.mock("../../services/spotify", () => ({
    spotifyService,
}));

const spotifyImportService = {
    generatePreview: jest.fn(),
    generatePreviewFromDeezer: jest.fn(),
    startImport: jest.fn(),
    getJob: jest.fn(),
    getUserJobs: jest.fn(),
    refreshJobMatches: jest.fn(),
    cancelJob: jest.fn(),
};

jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService,
}));

const deezerService = {
    getPlaylist: jest.fn(),
};

jest.mock("../../services/deezer", () => ({
    deezerService,
}));

const readSessionLog = jest.fn();
const getSessionLogPath = jest.fn();

jest.mock("../../utils/playlistLogger", () => ({
    readSessionLog: (...args: any[]) => readSessionLog(...args),
    getSessionLogPath: (...args: any[]) => getSessionLogPath(...args),
}));

import router from "../spotify";

function getHandler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
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

function makePreview(total: number, inLibrary: number) {
    return {
        summary: {
            total,
            inLibrary,
        },
    };
}

describe("spotify route runtime", () => {
    const parseHandler = getHandler("/parse", "post");
    const previewHandler = getHandler("/preview", "post");
    const importHandler = getHandler("/import", "post");
    const importStatusHandler = getHandler("/import/:jobId/status", "get");
    const importsHandler = getHandler("/imports", "get");
    const refreshHandler = getHandler("/import/:jobId/refresh", "post");
    const cancelHandler = getHandler("/import/:jobId/cancel", "post");
    const sessionLogHandler = getHandler("/import/session-log", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        spotifyService.parseUrl.mockReturnValue({
            type: "playlist",
            id: "sp-default",
        });

        spotifyImportService.generatePreview.mockResolvedValue(makePreview(5, 2));
        spotifyImportService.generatePreviewFromDeezer.mockResolvedValue(
            makePreview(4, 1)
        );
        spotifyImportService.startImport.mockResolvedValue({
            id: "job-1",
            status: "running",
        });
        spotifyImportService.getJob.mockResolvedValue({
            id: "job-1",
            userId: "u1",
            status: "running",
        });
        spotifyImportService.getUserJobs.mockResolvedValue([
            {
                id: "job-1",
                status: "running",
            },
        ]);
        spotifyImportService.refreshJobMatches.mockResolvedValue({
            added: 1,
            total: 10,
        });
        spotifyImportService.cancelJob.mockResolvedValue({
            playlistCreated: true,
            playlistId: "pl-1",
            tracksMatched: 3,
        });

        deezerService.getPlaylist.mockResolvedValue({
            id: "dz-1",
            title: "Deezer Playlist",
        });

        readSessionLog.mockReturnValue("session content");
        getSessionLogPath.mockReturnValue("/tmp/session.log");
    });

    describe("POST /parse", () => {
        it("handles invalid url schema", async () => {
            const req = { body: { url: "not-a-url" } } as any;
            const res = createRes();

            await parseHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid request body" });
            expect(spotifyService.parseUrl).not.toHaveBeenCalled();
        });

        it("returns 400 when parseUrl returns null", async () => {
            spotifyService.parseUrl.mockReturnValueOnce(null);

            const req = {
                body: { url: "https://open.spotify.com/playlist/abc123" },
            } as any;
            const res = createRes();

            await parseHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({
                error: "Invalid Spotify URL. Please provide a valid playlist URL.",
            });
        });

        it("returns 400 when parsed url is not a playlist", async () => {
            spotifyService.parseUrl.mockReturnValueOnce({
                type: "album",
                id: "album-1",
            });

            const req = {
                body: { url: "https://open.spotify.com/album/album-1" },
            } as any;
            const res = createRes();

            await parseHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({
                error: "Only playlist imports are supported. Got: album",
            });
        });

        it("returns parsed playlist details", async () => {
            spotifyService.parseUrl.mockReturnValueOnce({
                type: "playlist",
                id: "playlist-1",
            });

            const req = {
                body: { url: "https://open.spotify.com/playlist/playlist-1" },
            } as any;
            const res = createRes();

            await parseHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                type: "playlist",
                id: "playlist-1",
                url: "https://open.spotify.com/playlist/playlist-1",
            });
        });
    });

    describe("POST /preview", () => {
        it("returns spotify preview for spotify URLs", async () => {
            const preview = makePreview(12, 4);
            spotifyImportService.generatePreview.mockResolvedValueOnce(preview);

            const req = {
                body: {
                    url: "https://open.spotify.com/playlist/spotify-preview-1",
                },
            } as any;
            const res = createRes();

            await previewHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(preview);
            expect(spotifyImportService.generatePreview).toHaveBeenCalledWith(
                "https://open.spotify.com/playlist/spotify-preview-1"
            );
            expect(deezerService.getPlaylist).not.toHaveBeenCalled();
        });

        it("returns 400 for deezer urls without a playlist id", async () => {
            const req = {
                body: { url: "https://www.deezer.com/artist/123" },
            } as any;
            const res = createRes();

            await previewHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid Deezer playlist URL" });
            expect(deezerService.getPlaylist).not.toHaveBeenCalled();
        });

        it("returns 404 when deezer playlist is missing", async () => {
            deezerService.getPlaylist.mockResolvedValueOnce(null);

            const req = {
                body: { url: "https://www.deezer.com/playlist/54321" },
            } as any;
            const res = createRes();

            await previewHandler(req, res);

            expect(deezerService.getPlaylist).toHaveBeenCalledWith("54321");
            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Deezer playlist not found" });
        });

        it("returns deezer preview when playlist exists", async () => {
            const deezerPlaylist = { id: "54321", title: "DZ" };
            const preview = makePreview(9, 3);
            deezerService.getPlaylist.mockResolvedValueOnce(deezerPlaylist);
            spotifyImportService.generatePreviewFromDeezer.mockResolvedValueOnce(
                preview
            );

            const req = {
                body: { url: "https://www.deezer.com/playlist/54321" },
            } as any;
            const res = createRes();

            await previewHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(preview);
            expect(spotifyImportService.generatePreviewFromDeezer).toHaveBeenCalledWith(
                deezerPlaylist
            );
            expect(spotifyImportService.generatePreview).not.toHaveBeenCalled();
        });

        it("returns 400 on zod body validation error", async () => {
            const req = { body: {} } as any;
            const res = createRes();

            await previewHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid request body" });
        });

        it("returns 500 when preview generation throws", async () => {
            spotifyImportService.generatePreview.mockRejectedValueOnce(
                new Error("preview failed")
            );

            const req = {
                body: { url: "https://open.spotify.com/playlist/explode" },
            } as any;
            const res = createRes();

            await previewHandler(req, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "preview failed" });
        });
    });

    describe("POST /import", () => {
        it("returns 401 when user is missing", async () => {
            const req = {
                body: {
                    spotifyPlaylistId: "sp-1",
                    playlistName: "My Playlist",
                    albumMbidsToDownload: [],
                },
            } as any;
            const res = createRes();

            await importHandler(req, res);

            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Unauthorized" });
        });

        it("returns 400 for invalid deezer url", async () => {
            const req = {
                user: { id: "u1" },
                body: {
                    spotifyPlaylistId: "sp-1",
                    url: "https://www.deezer.com/artist/123",
                    playlistName: "DZ Import",
                    albumMbidsToDownload: ["mbid-1"],
                },
            } as any;
            const res = createRes();

            await importHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid Deezer playlist URL" });
            expect(spotifyImportService.startImport).not.toHaveBeenCalled();
        });

        it("returns 404 when deezer playlist is missing", async () => {
            deezerService.getPlaylist.mockResolvedValueOnce(null);

            const req = {
                user: { id: "u1" },
                body: {
                    spotifyPlaylistId: "sp-1",
                    url: "https://www.deezer.com/playlist/999",
                    playlistName: "DZ Import",
                    albumMbidsToDownload: ["mbid-1"],
                },
            } as any;
            const res = createRes();

            await importHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Deezer playlist not found" });
            expect(spotifyImportService.startImport).not.toHaveBeenCalled();
        });

        it("starts spotify import using fallback spotify URL", async () => {
            const preview = makePreview(15, 5);
            spotifyImportService.generatePreview.mockResolvedValueOnce(preview);
            spotifyImportService.startImport.mockResolvedValueOnce({
                id: "job-spotify",
                status: "running",
            });

            const req = {
                user: { id: "u1" },
                body: {
                    spotifyPlaylistId: "spotify-playlist-1",
                    playlistName: "Spotify Import",
                    albumMbidsToDownload: ["mbid-1", "mbid-2"],
                },
            } as any;
            const res = createRes();

            await importHandler(req, res);

            expect(spotifyImportService.generatePreview).toHaveBeenCalledWith(
                "https://open.spotify.com/playlist/spotify-playlist-1"
            );
            expect(spotifyImportService.startImport).toHaveBeenCalledWith(
                "u1",
                "spotify-playlist-1",
                "Spotify Import",
                [],
                preview
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                jobId: "job-spotify",
                status: "running",
                message: "Import started",
            });
        });

        it("starts import from deezer preview", async () => {
            const deezerPlaylist = { id: "123", title: "DZ Mix" };
            const preview = makePreview(11, 1);
            deezerService.getPlaylist.mockResolvedValueOnce(deezerPlaylist);
            spotifyImportService.generatePreviewFromDeezer.mockResolvedValueOnce(
                preview
            );
            spotifyImportService.startImport.mockResolvedValueOnce({
                id: "job-deezer",
                status: "queued",
            });

            const req = {
                user: { id: "u1" },
                body: {
                    spotifyPlaylistId: "deezer-proxy-id",
                    url: "https://www.deezer.com/playlist/123",
                    playlistName: "Deezer Import",
                    albumMbidsToDownload: ["mbid-9"],
                },
            } as any;
            const res = createRes();

            await importHandler(req, res);

            expect(deezerService.getPlaylist).toHaveBeenCalledWith("123");
            expect(spotifyImportService.generatePreviewFromDeezer).toHaveBeenCalledWith(
                deezerPlaylist
            );
            expect(spotifyImportService.startImport).toHaveBeenCalledWith(
                "u1",
                "deezer-proxy-id",
                "Deezer Import",
                [],
                preview
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                jobId: "job-deezer",
                status: "queued",
                message: "Import started",
            });
        });

        it("returns 400 on zod body validation error", async () => {
            const req = {
                user: { id: "u1" },
                body: {
                    spotifyPlaylistId: "sp-1",
                    playlistName: "Missing albums array",
                },
            } as any;
            const res = createRes();

            await importHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid request body" });
            expect(spotifyImportService.startImport).not.toHaveBeenCalled();
        });
    });

    describe("GET /import/:jobId/status", () => {
        it("returns 401 when user is missing", async () => {
            const req = { params: { jobId: "job-1" } } as any;
            const res = createRes();

            await importStatusHandler(req, res);

            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Unauthorized" });
        });

        it("returns 404 when job does not exist", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce(null);

            const req = {
                user: { id: "u1" },
                params: { jobId: "missing-job" },
            } as any;
            const res = createRes();

            await importStatusHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Import job not found" });
        });

        it("returns 403 for non-owner", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "other-user",
                status: "running",
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await importStatusHandler(req, res);

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ error: "Not authorized to view this job" });
        });

        it("returns job details for owner", async () => {
            const job = {
                id: "job-1",
                userId: "u1",
                status: "completed",
                progress: 100,
            };
            spotifyImportService.getJob.mockResolvedValueOnce(job);

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await importStatusHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(job);
        });

        it("returns 500 when getJob throws", async () => {
            spotifyImportService.getJob.mockRejectedValueOnce(
                new Error("status failed")
            );

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await importStatusHandler(req, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "status failed" });
        });
    });

    describe("GET /imports", () => {
        it("returns 401 when user is missing", async () => {
            const req = {} as any;
            const res = createRes();

            await importsHandler(req, res);

            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Unauthorized" });
        });

        it("returns user imports", async () => {
            const jobs = [
                { id: "job-1", status: "running" },
                { id: "job-2", status: "completed" },
            ];
            spotifyImportService.getUserJobs.mockResolvedValueOnce(jobs);

            const req = { user: { id: "u1" } } as any;
            const res = createRes();

            await importsHandler(req, res);

            expect(spotifyImportService.getUserJobs).toHaveBeenCalledWith("u1");
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(jobs);
        });

        it("returns 500 when import listing fails", async () => {
            spotifyImportService.getUserJobs.mockRejectedValueOnce(
                new Error("list failed")
            );

            const req = { user: { id: "u1" } } as any;
            const res = createRes();

            await importsHandler(req, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "list failed" });
        });
    });

    describe("POST /import/:jobId/refresh", () => {
        it("returns 401 when user is missing", async () => {
            const req = { params: { jobId: "job-1" } } as any;
            const res = createRes();

            await refreshHandler(req, res);

            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Unauthorized" });
        });

        it("returns 404 when job does not exist", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce(null);

            const req = {
                user: { id: "u1" },
                params: { jobId: "missing-job" },
            } as any;
            const res = createRes();

            await refreshHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Import job not found" });
        });

        it("returns 403 for non-owner", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "other-user",
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await refreshHandler(req, res);

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ error: "Not authorized to refresh this job" });
        });

        it("returns added message when newly downloaded tracks are found", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "u1",
            });
            spotifyImportService.refreshJobMatches.mockResolvedValueOnce({
                added: 2,
                total: 10,
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await refreshHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                message: "Added 2 newly downloaded track(s)",
                added: 2,
                total: 10,
            });
        });

        it("returns waiting message when no new tracks were added", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "u1",
            });
            spotifyImportService.refreshJobMatches.mockResolvedValueOnce({
                added: 0,
                total: 10,
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await refreshHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                message: "No new tracks found yet. Albums may still be downloading.",
                added: 0,
                total: 10,
            });
        });

        it("returns 500 when refresh fails", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "u1",
            });
            spotifyImportService.refreshJobMatches.mockRejectedValueOnce(
                new Error("refresh failed")
            );

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await refreshHandler(req, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "refresh failed" });
        });
    });

    describe("POST /import/:jobId/cancel", () => {
        it("returns 404 when job is missing", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce(null);

            const req = {
                user: { id: "u1" },
                params: { jobId: "missing-job" },
            } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Import job not found" });
        });

        it("returns 403 for non-owner", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "other-user",
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ error: "Not authorized to cancel this job" });
        });

        it("returns playlist-created cancel message", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "u1",
            });
            spotifyImportService.cancelJob.mockResolvedValueOnce({
                playlistCreated: true,
                playlistId: "playlist-1",
                tracksMatched: 7,
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                message: "Import cancelled. Playlist created with 7 track(s).",
                playlistId: "playlist-1",
                tracksMatched: 7,
            });
        });

        it("returns no-tracks cancel message when playlist was not created", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "u1",
            });
            spotifyImportService.cancelJob.mockResolvedValueOnce({
                playlistCreated: false,
                playlistId: null,
                tracksMatched: 0,
            });

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                message: "Import cancelled. No tracks were downloaded.",
                playlistId: null,
                tracksMatched: 0,
            });
        });

        it("returns 500 when cancellation fails", async () => {
            spotifyImportService.getJob.mockResolvedValueOnce({
                id: "job-1",
                userId: "u1",
            });
            spotifyImportService.cancelJob.mockRejectedValueOnce(
                new Error("cancel failed")
            );

            const req = {
                user: { id: "u1" },
                params: { jobId: "job-1" },
            } as any;
            const res = createRes();

            await cancelHandler(req, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "cancel failed" });
        });
    });

    describe("GET /import/session-log", () => {
        it("returns log path and content", async () => {
            readSessionLog.mockReturnValueOnce("log contents");
            getSessionLogPath.mockReturnValueOnce("/tmp/playlist-session.log");

            const req = {} as any;
            const res = createRes();

            await sessionLogHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                path: "/tmp/playlist-session.log",
                content: "log contents",
            });
        });

        it("returns 500 when reading session log fails", async () => {
            readSessionLog.mockImplementationOnce(() => {
                throw new Error("session read failed");
            });

            const req = {} as any;
            const res = createRes();

            await sessionLogHandler(req, res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "session read failed" });
        });
    });
});
