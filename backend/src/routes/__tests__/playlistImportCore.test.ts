import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const AUTH_HEADER = "x-test-auth";
const AUTH_VALUE = "ok";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
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

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../services/playlistImportService", () => ({
    playlistImportService: {
        parseSourceUrl: jest.fn(),
        previewImport: jest.fn(),
        previewM3UImport: jest.fn(),
        importPlaylist: jest.fn(),
    },
}));

jest.mock("../../services/importJobStore", () => ({
    importJobStore: {
        createJob: jest.fn(),
        getJob: jest.fn(),
        listJobsForUser: jest.fn(),
        findActiveJobForSource: jest.fn(),
        updateJob: jest.fn(),
    },
}));

jest.mock("../../services/genericImportJobRunner", () => ({
    genericImportJobRunner: {
        enqueue: jest.fn(),
    },
}));

import { genericImportJobRunner } from "../../services/genericImportJobRunner";
import { importJobStore } from "../../services/importJobStore";
import { playlistImportService } from "../../services/playlistImportService";
import { logger } from "../../utils/logger";
import router from "../playlistImport";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/import", router);

const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;
const mockParseSourceUrl = playlistImportService.parseSourceUrl as jest.Mock;
const mockPreviewImport = playlistImportService.previewImport as jest.Mock;
const mockPreviewM3UImport = playlistImportService.previewM3UImport as jest.Mock;
const mockImportPlaylist = playlistImportService.importPlaylist as jest.Mock;
const mockCreateJob = importJobStore.createJob as jest.Mock;
const mockGetJob = importJobStore.getJob as jest.Mock;
const mockListJobsForUser = importJobStore.listJobsForUser as jest.Mock;
const mockFindActiveJobForSource = importJobStore.findActiveJobForSource as jest.Mock;
const mockUpdateJob = importJobStore.updateJob as jest.Mock;
const mockEnqueueImportJob = genericImportJobRunner.enqueue as jest.Mock;

const spotifyUrl = "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk";
const tidalUrl =
    "https://tidal.com/playlist/a1b2c3d4-e5f6-0000-0000-000000000001";
const previewData = {
    playlistName: "Imported Playlist",
    resolved: [
        {
            index: 0,
            artist: "Artist A",
            title: "Song A",
            album: "Album A",
            source: "local",
            confidence: 100,
            trackId: "track-1",
        },
        {
            index: 1,
            artist: "Artist B",
            title: "Song B",
            source: "youtube",
            confidence: 87,
            trackYtMusicId: "yt-1",
        },
    ],
    summary: {
        total: 2,
        local: 1,
        youtube: 1,
        tidal: 0,
        unresolved: 0,
    },
};

describe("playlistImport route core coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("authentication", () => {
        it.each([
            ["post", "/api/import/jobs", { url: spotifyUrl }],
            ["get", "/api/import/jobs", undefined],
            ["get", "/api/import/jobs/job-1", undefined],
            ["post", "/api/import/jobs/reconnect", { url: spotifyUrl }],
            ["post", "/api/import/jobs/job-1/cancel", undefined],
            ["post", "/api/import/m3u/preview", { content: "#EXTM3U\n" }],
            ["post", "/api/import/preview", { url: spotifyUrl }],
            ["post", "/api/import/execute", { previewData }],
        ] as const)("requires auth for %s %s", async (method, path, body) => {
            const req = request(app)[method](path);

            if (body) {
                req.send(body);
            }

            const res = await req;

            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: "Not authenticated" });
        });
    });

    describe("POST /api/import/jobs", () => {
        it("creates a new job and enqueues it", async () => {
            const createdJob = {
                id: "job-new",
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "37i9dQZF1DX4JAvHpjipBk",
                sourceUrl: spotifyUrl,
                playlistName: "Spotify import",
                requestedPlaylistName: "Roadtrip",
                status: "pending",
                progress: 0,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };

            mockParseSourceUrl.mockReturnValueOnce({
                source: "spotify",
                id: "37i9dQZF1DX4JAvHpjipBk",
            });
            mockFindActiveJobForSource.mockResolvedValueOnce(null);
            mockCreateJob.mockResolvedValueOnce(createdJob);

            const res = await request(app)
                .post("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl, name: "Roadtrip" });

            expect(res.status).toBe(202);
            expect(res.body).toEqual({ deduped: false, job: createdJob });
            expect(mockFindActiveJobForSource).toHaveBeenCalledWith(
                "user-1",
                "spotify:37i9dQZF1DX4JAvHpjipBk"
            );
            expect(mockCreateJob).toHaveBeenCalledWith({
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "37i9dQZF1DX4JAvHpjipBk",
                sourceUrl: spotifyUrl,
                playlistName: "Spotify import",
                requestedPlaylistName: "Roadtrip",
                status: "pending",
                progress: 0,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            });
            expect(mockEnqueueImportJob).toHaveBeenCalledWith("job-new");
        });

        it("returns an existing job for a duplicate source", async () => {
            const existingJob = {
                id: "job-existing",
                userId: "user-1",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                status: "resolving",
            };

            mockParseSourceUrl.mockReturnValueOnce({
                source: "spotify",
                id: "37i9dQZF1DX4JAvHpjipBk",
            });
            mockFindActiveJobForSource.mockResolvedValueOnce(existingJob);

            const res = await request(app)
                .post("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ deduped: true, job: existingJob });
            expect(mockCreateJob).not.toHaveBeenCalled();
            expect(mockEnqueueImportJob).not.toHaveBeenCalled();
        });

        it("returns 400 for invalid or unsupported job submissions", async () => {
            const invalidRes = await request(app)
                .post("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: "not-a-url" });

            mockParseSourceUrl.mockReturnValueOnce(null);

            const unsupportedRes = await request(app)
                .post("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            expect(invalidRes.status).toBe(400);
            expect(invalidRes.body).toEqual({
                error: "Valid playlist URL is required",
            });
            expect(unsupportedRes.status).toBe(400);
            expect(unsupportedRes.body).toEqual({ error: "Unsupported playlist URL" });
        });

        it("returns 500 when submit fails", async () => {
            const boom = new Error("job store down");
            mockParseSourceUrl.mockReturnValueOnce({
                source: "spotify",
                id: "37i9dQZF1DX4JAvHpjipBk",
            });
            mockFindActiveJobForSource.mockRejectedValueOnce(boom);

            const res = await request(app)
                .post("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: "Failed to submit import job" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Job submit failed:",
                boom
            );
        });
    });

    describe("GET /api/import/jobs", () => {
        it("lists the current user's jobs", async () => {
            const jobs = [{ id: "job-1", userId: "user-1", status: "completed" }];
            mockListJobsForUser.mockResolvedValueOnce(jobs);

            const res = await request(app)
                .get("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ jobs });
            expect(mockListJobsForUser).toHaveBeenCalledWith("user-1");
        });

        it("returns 500 when job listing fails", async () => {
            const boom = new Error("list failed");
            mockListJobsForUser.mockRejectedValueOnce(boom);

            const res = await request(app)
                .get("/api/import/jobs")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: "Failed to list import jobs" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Job list failed:",
                boom
            );
        });
    });

    describe("GET /api/import/jobs/:jobId", () => {
        it("returns a job when owned by the user", async () => {
            const job = { id: "job-1", userId: "user-1", status: "resolving" };
            mockGetJob.mockResolvedValueOnce(job);

            const res = await request(app)
                .get("/api/import/jobs/job-1")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ job });
        });

        it("returns 404, 403, and 500 for job status errors", async () => {
            mockGetJob.mockResolvedValueOnce(null);
            const notFoundRes = await request(app)
                .get("/api/import/jobs/job-missing")
                .set(AUTH_HEADER, AUTH_VALUE);

            mockGetJob.mockResolvedValueOnce({
                id: "job-2",
                userId: "user-2",
                status: "resolving",
            });
            const forbiddenRes = await request(app)
                .get("/api/import/jobs/job-2")
                .set(AUTH_HEADER, AUTH_VALUE);

            const boom = new Error("lookup failed");
            mockGetJob.mockRejectedValueOnce(boom);
            const errorRes = await request(app)
                .get("/api/import/jobs/job-3")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(notFoundRes.status).toBe(404);
            expect(notFoundRes.body).toEqual({ error: "Import job not found" });
            expect(forbiddenRes.status).toBe(403);
            expect(forbiddenRes.body).toEqual({
                error: "Not authorized to view this import job",
            });
            expect(errorRes.status).toBe(500);
            expect(errorRes.body).toEqual({ error: "Failed to load import job" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Job status failed:",
                boom
            );
        });
    });

    describe("POST /api/import/jobs/reconnect", () => {
        it("finds an active job by source URL", async () => {
            const job = {
                id: "job-active",
                userId: "user-1",
                normalizedSource: "tidal:a1b2c3d4-e5f6-0000-0000-000000000001",
                status: "creating_playlist",
            };

            mockParseSourceUrl.mockReturnValueOnce({
                source: "tidal",
                id: "a1b2c3d4-e5f6-0000-0000-000000000001",
            });
            mockFindActiveJobForSource.mockResolvedValueOnce(job);

            const res = await request(app)
                .post("/api/import/jobs/reconnect")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: tidalUrl });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ job });
            expect(mockFindActiveJobForSource).toHaveBeenCalledWith(
                "user-1",
                "tidal:a1b2c3d4-e5f6-0000-0000-000000000001"
            );
        });

        it("returns 400, 404, and 500 for reconnect errors", async () => {
            const invalidRes = await request(app)
                .post("/api/import/jobs/reconnect")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: "not-a-url" });

            mockParseSourceUrl.mockReturnValueOnce(null);
            const unsupportedRes = await request(app)
                .post("/api/import/jobs/reconnect")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            mockParseSourceUrl.mockReturnValueOnce({
                source: "spotify",
                id: "37i9dQZF1DX4JAvHpjipBk",
            });
            mockFindActiveJobForSource.mockResolvedValueOnce(null);
            const notFoundRes = await request(app)
                .post("/api/import/jobs/reconnect")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            const boom = new Error("reconnect failed");
            mockParseSourceUrl.mockReturnValueOnce({
                source: "spotify",
                id: "37i9dQZF1DX4JAvHpjipBk",
            });
            mockFindActiveJobForSource.mockRejectedValueOnce(boom);
            const errorRes = await request(app)
                .post("/api/import/jobs/reconnect")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            expect(invalidRes.status).toBe(400);
            expect(invalidRes.body).toEqual({
                error: "Valid playlist URL is required",
            });
            expect(unsupportedRes.status).toBe(400);
            expect(unsupportedRes.body).toEqual({ error: "Unsupported playlist URL" });
            expect(notFoundRes.status).toBe(404);
            expect(notFoundRes.body).toEqual({
                error: "No active import job found for source",
            });
            expect(errorRes.status).toBe(500);
            expect(errorRes.body).toEqual({ error: "Failed to reconnect import job" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Job reconnect failed:",
                boom
            );
        });
    });

    describe("POST /api/import/jobs/:jobId/cancel", () => {
        it("updates the job status to cancelling", async () => {
            const currentJob = { id: "job-1", userId: "user-1", status: "resolving" };
            const cancelledJob = {
                id: "job-1",
                userId: "user-1",
                status: "cancelling",
                error: "Cancelled by user",
            };
            mockGetJob.mockResolvedValueOnce(currentJob);
            mockUpdateJob.mockResolvedValueOnce(cancelledJob);

            const res = await request(app)
                .post("/api/import/jobs/job-1/cancel")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ job: cancelledJob });
            expect(mockUpdateJob).toHaveBeenCalledWith("job-1", {
                status: "cancelling",
                error: "Cancelled by user",
            });
        });

        it("returns 404, 403, 409, and 500 for cancel errors", async () => {
            mockGetJob.mockResolvedValueOnce(null);
            const notFoundRes = await request(app)
                .post("/api/import/jobs/job-missing/cancel")
                .set(AUTH_HEADER, AUTH_VALUE);

            mockGetJob.mockResolvedValueOnce({
                id: "job-2",
                userId: "user-2",
                status: "resolving",
            });
            const forbiddenRes = await request(app)
                .post("/api/import/jobs/job-2/cancel")
                .set(AUTH_HEADER, AUTH_VALUE);

            mockGetJob.mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                status: "completed",
            });
            const conflictRes = await request(app)
                .post("/api/import/jobs/job-3/cancel")
                .set(AUTH_HEADER, AUTH_VALUE);

            const boom = new Error("cancel failed");
            mockGetJob.mockRejectedValueOnce(boom);
            const errorRes = await request(app)
                .post("/api/import/jobs/job-4/cancel")
                .set(AUTH_HEADER, AUTH_VALUE);

            expect(notFoundRes.status).toBe(404);
            expect(notFoundRes.body).toEqual({ error: "Import job not found" });
            expect(forbiddenRes.status).toBe(403);
            expect(forbiddenRes.body).toEqual({
                error: "Not authorized to cancel this import job",
            });
            expect(conflictRes.status).toBe(409);
            expect(conflictRes.body).toEqual({ error: "Import job already completed" });
            expect(errorRes.status).toBe(500);
            expect(errorRes.body).toEqual({ error: "Failed to cancel import job" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Job cancel failed:",
                boom
            );
        });
    });

    describe("POST /api/import/m3u/preview", () => {
        it("parses M3U content and returns a preview", async () => {
            const m3uPreview = {
                playlistName: "Road Trip",
                resolved: [
                    {
                        index: 0,
                        artist: "Artist A",
                        title: "Song A",
                        source: "local",
                        trackId: "track-1",
                        confidence: 100,
                    },
                ],
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };
            const content = "#EXTM3U\n#EXTINF:200,Artist A - Song A\n/music/a.flac";
            mockPreviewM3UImport.mockResolvedValueOnce(m3uPreview);

            const res = await request(app)
                .post("/api/import/m3u/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ name: "Road Trip", content });

            expect(res.status).toBe(200);
            expect(res.body).toEqual(m3uPreview);
            expect(mockPreviewM3UImport).toHaveBeenCalledWith("Road Trip", content);
        });

        it("returns default name, validation failures, and 500 for M3U preview", async () => {
            mockPreviewM3UImport.mockResolvedValueOnce({
                playlistName: "M3U import",
                resolved: [],
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            });
            const defaultNameRes = await request(app)
                .post("/api/import/m3u/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ content: "#EXTM3U\n" });

            const missingContentRes = await request(app)
                .post("/api/import/m3u/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ name: "Missing" });

            const tooLargeRes = await request(app)
                .post("/api/import/m3u/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ content: "x".repeat(2_000_001) });

            const boom = new Error("m3u preview failed");
            mockPreviewM3UImport.mockRejectedValueOnce(boom);
            const errorRes = await request(app)
                .post("/api/import/m3u/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ content: "#EXTM3U\n#EXTINF:1,Artist - Song\n/music/a.flac" });

            expect(defaultNameRes.status).toBe(200);
            expect(mockPreviewM3UImport).toHaveBeenCalledWith("M3U import", "#EXTM3U\n");
            expect(missingContentRes.status).toBe(400);
            expect(missingContentRes.body).toEqual({
                error: "Playlist file content is required",
            });
            expect([400, 413]).toContain(tooLargeRes.status);
            expect(errorRes.status).toBe(500);
            expect(errorRes.body).toEqual({ error: "Failed to preview M3U import" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] M3U preview failed:",
                boom
            );
        });
    });

    describe("POST /api/import/preview", () => {
        it("resolves tracks from a provider URL", async () => {
            const previewResult = {
                source: "spotify",
                playlistName: "Weekend Mix",
                resolved: previewData.resolved,
                summary: previewData.summary,
            };
            mockPreviewImport.mockResolvedValueOnce(previewResult);

            const res = await request(app)
                .post("/api/import/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            expect(res.status).toBe(200);
            expect(res.body).toEqual(previewResult);
            expect(mockPreviewImport).toHaveBeenCalledWith("user-1", spotifyUrl);
        });

        it("returns 400, 502, and 500 for preview failures", async () => {
            const invalidRes = await request(app)
                .post("/api/import/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: "not-a-url" });

            mockPreviewImport.mockRejectedValueOnce(new Error("Unsupported playlist URL"));
            const unsupportedRes = await request(app)
                .post("/api/import/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            mockPreviewImport.mockRejectedValueOnce(
                new Error("ECONNREFUSED: connect failed to ytmusic-streamer")
            );
            const unavailableRes = await request(app)
                .post("/api/import/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            const boom = new Error("unexpected preview failure");
            mockPreviewImport.mockRejectedValueOnce(boom);
            const errorRes = await request(app)
                .post("/api/import/preview")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ url: spotifyUrl });

            expect(invalidRes.status).toBe(400);
            expect(invalidRes.body).toEqual({
                error: "Valid playlist URL is required",
            });
            expect(unsupportedRes.status).toBe(400);
            expect(unsupportedRes.body).toEqual({ error: "Unsupported playlist URL" });
            expect(unavailableRes.status).toBe(502);
            expect(unavailableRes.body).toEqual({ error: "External service unavailable" });
            expect(mockLoggerWarn).toHaveBeenCalledWith(
                "[Import] External service unavailable:",
                expect.any(Error)
            );
            expect(errorRes.status).toBe(500);
            expect(errorRes.body).toEqual({ error: "Failed to preview import" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Preview failed:",
                boom
            );
        });
    });

    describe("POST /api/import/execute", () => {
        it("creates a playlist from preview data", async () => {
            const executeResult = {
                playlistId: "playlist-123",
                playlistName: "Custom Name",
                summary: previewData.summary,
            };
            mockImportPlaylist.mockResolvedValueOnce(executeResult);

            const res = await request(app)
                .post("/api/import/execute")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ previewData, name: "Custom Name" });

            expect(res.status).toBe(200);
            expect(res.body).toEqual(executeResult);
            expect(mockImportPlaylist).toHaveBeenCalledWith(
                "user-1",
                previewData,
                "Custom Name"
            );
        });

        it("returns 400 and 500 for execute failures", async () => {
            const invalidBodyRes = await request(app)
                .post("/api/import/execute")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ name: "Missing preview" });

            mockImportPlaylist.mockRejectedValueOnce(
                new Error("Invalid track reference for track 2")
            );
            const invalidTrackRes = await request(app)
                .post("/api/import/execute")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ previewData });

            const boom = new Error("execute failed");
            mockImportPlaylist.mockRejectedValueOnce(boom);
            const errorRes = await request(app)
                .post("/api/import/execute")
                .set(AUTH_HEADER, AUTH_VALUE)
                .send({ previewData });

            expect(invalidBodyRes.status).toBe(400);
            expect(invalidBodyRes.body).toEqual({
                error: "Valid previewData is required",
            });
            expect(invalidTrackRes.status).toBe(400);
            expect(invalidTrackRes.body).toEqual({
                error: "Invalid track reference for track 2",
            });
            expect(errorRes.status).toBe(500);
            expect(errorRes.body).toEqual({ error: "Failed to execute import" });
            expect(mockLoggerError).toHaveBeenCalledWith(
                "[Import] Execute failed:",
                boom
            );
        });
    });
});
