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

import { playlistImportService } from "../../services/playlistImportService";
import { importJobStore } from "../../services/importJobStore";
import { genericImportJobRunner } from "../../services/genericImportJobRunner";
import router from "../playlistImport";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/import", router);

describe("import routes integration", () => {
    const mockParseSourceUrl = playlistImportService.parseSourceUrl as jest.Mock;
    const mockPreviewImport = playlistImportService.previewImport as jest.Mock;
    const mockPreviewM3UImport = playlistImportService.previewM3UImport as jest.Mock;
    const mockImportPlaylist = playlistImportService.importPlaylist as jest.Mock;
    const mockCreateJob = importJobStore.createJob as jest.Mock;
    const mockGetJob = importJobStore.getJob as jest.Mock;
    const mockListJobsForUser = importJobStore.listJobsForUser as jest.Mock;
    const mockFindActiveJobForSource =
        importJobStore.findActiveJobForSource as jest.Mock;
    const mockUpdateJob = importJobStore.updateJob as jest.Mock;
    const mockEnqueueImportJob = genericImportJobRunner.enqueue as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("requires auth for POST /api/import/preview", async () => {
        const res = await request(app)
            .post("/api/import/preview")
            .send({ url: "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk" });

        expect(res.status).toBe(401);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });

    it("validates preview payload and returns 400 for invalid url", async () => {
        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "not-a-url" });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Valid playlist URL is required",
            })
        );
        expect(mockPreviewImport).not.toHaveBeenCalled();
    });

    it("returns preview results for valid import URLs", async () => {
        const preview = {
            source: "spotify",
            playlistName: "Weekend Mix",
            totalTracks: 2,
            resolvedTracks: [
                { title: "Track 1", matched: true },
                { title: "Track 2", matched: false },
            ],
        };
        mockPreviewImport.mockResolvedValueOnce(preview);

        const url = "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk";
        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(preview);
        expect(mockPreviewImport).toHaveBeenCalledWith("user-1", url);
    });

    it("creates a new generic import job for a valid provider URL", async () => {
        mockParseSourceUrl.mockReturnValueOnce({
            source: "spotify",
            id: "37i9dQZF1DX4JAvHpjipBk",
        });
        mockFindActiveJobForSource.mockResolvedValueOnce(null);
        mockCreateJob.mockResolvedValueOnce({
            id: "job-new",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "37i9dQZF1DX4JAvHpjipBk",
            sourceUrl:
                "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
            normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
            playlistName: "Spotify import",
            requestedPlaylistName: "Roadtrip",
            status: "pending",
            progress: 0,
            summary: { total: 0, local: 0, youtube: 0, tidal: 0, unresolved: 0 },
            resolvedTracks: null,
            createdPlaylistId: null,
            error: null,
            createdAt: "2026-03-14T17:00:00.000Z",
            updatedAt: "2026-03-14T17:00:00.000Z",
        });

        const url = "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk";
        const res = await request(app)
            .post("/api/import/jobs")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url, name: "Roadtrip" });

        expect(res.status).toBe(202);
        expect(res.body).toEqual({
            deduped: false,
            job: expect.objectContaining({
                id: "job-new",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                status: "pending",
            }),
        });
        expect(mockFindActiveJobForSource).toHaveBeenCalledWith(
            "user-1",
            "spotify:37i9dQZF1DX4JAvHpjipBk"
        );
        expect(mockCreateJob).toHaveBeenCalledWith({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "37i9dQZF1DX4JAvHpjipBk",
            sourceUrl: url,
            playlistName: "Spotify import",
            requestedPlaylistName: "Roadtrip",
            status: "pending",
            progress: 0,
            summary: { total: 0, local: 0, youtube: 0, tidal: 0, unresolved: 0 },
        });
        expect(mockEnqueueImportJob).toHaveBeenCalledWith("job-new");
    });

    it("returns the existing active generic import job on duplicate submit", async () => {
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
            .send({
                url: "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            deduped: true,
            job: existingJob,
        });
        expect(mockCreateJob).not.toHaveBeenCalled();
        expect(mockEnqueueImportJob).not.toHaveBeenCalled();
    });

    it("reconnects to an active generic import job by URL", async () => {
        const existingJob = {
            id: "job-existing",
            userId: "user-1",
            normalizedSource: "deezer:12345",
            status: "creating_playlist",
        };
        mockParseSourceUrl.mockReturnValueOnce({
            source: "deezer",
            id: "12345",
        });
        mockFindActiveJobForSource.mockResolvedValueOnce(existingJob);

        const res = await request(app)
            .post("/api/import/jobs/reconnect")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "https://deezer.com/playlist/12345" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ job: existingJob });
    });

    it("lists a user's generic import jobs", async () => {
        mockListJobsForUser.mockResolvedValueOnce([
            { id: "job-1", userId: "user-1", status: "completed" },
        ]);

        const res = await request(app)
            .get("/api/import/jobs")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            jobs: [{ id: "job-1", userId: "user-1", status: "completed" }],
        });
        expect(mockListJobsForUser).toHaveBeenCalledWith("user-1");
    });

    it("returns a generic import job status for the owning user", async () => {
        mockGetJob.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
            status: "resolving",
        });

        const res = await request(app)
            .get("/api/import/jobs/job-1")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            job: { id: "job-1", userId: "user-1", status: "resolving" },
        });
    });

    it("rejects status access for a generic import job owned by another user", async () => {
        mockGetJob.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-2",
            status: "resolving",
        });

        const res = await request(app)
            .get("/api/import/jobs/job-1")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(403);
        expect(res.body).toEqual({
            error: "Not authorized to view this import job",
        });
    });

    it("cancels an active generic import job for the owning user", async () => {
        mockGetJob.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
            status: "resolving",
        });
        mockUpdateJob.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
            status: "cancelling",
        });

        const res = await request(app)
            .post("/api/import/jobs/job-1/cancel")
            .set(AUTH_HEADER, AUTH_VALUE);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            job: { id: "job-1", userId: "user-1", status: "cancelling" },
        });
        expect(mockUpdateJob).toHaveBeenCalledWith("job-1", {
            status: "cancelling",
            error: "Cancelled by user",
        });
    });

    it("rejects execute when previewData is missing", async () => {
        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ name: "Test" });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Valid previewData is required",
            })
        );
        expect(mockImportPlaylist).not.toHaveBeenCalled();
    });

    it("rejects execute when source/ID linkage is inconsistent", async () => {
        const previewData = {
            playlistName: "Bad Playlist",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "local",
                    confidence: 100,
                    // source is "local" but has no trackId — inconsistent
                },
            ],
            summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
        };

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ previewData });

        expect(res.status).toBe(400);
        expect(mockImportPlaylist).not.toHaveBeenCalled();
    });

    it("rejects execute when youtube source has no trackYtMusicId", async () => {
        const previewData = {
            playlistName: "Bad YT Playlist",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "youtube",
                    confidence: 85,
                    // missing trackYtMusicId
                },
            ],
            summary: { total: 1, local: 0, youtube: 1, tidal: 0, unresolved: 0 },
        };

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ previewData });

        expect(res.status).toBe(400);
        expect(mockImportPlaylist).not.toHaveBeenCalled();
    });

    it("returns 502 when sidecar fetch fails during preview", async () => {
        mockPreviewImport.mockRejectedValueOnce(
            new Error("ECONNREFUSED: connect failed to ytmusic-streamer:8586")
        );

        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "https://music.youtube.com/playlist?list=PLtest" });

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/external service/i);
    });

    it("returns 400 when Tidal auth is required but missing during preview", async () => {
        mockPreviewImport.mockRejectedValueOnce(
            new Error("Tidal import requires authentication")
        );

        const res = await request(app)
            .post("/api/import/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ url: "https://tidal.com/playlist/a1b2c3d4-e5f6-0000-0000-000000000001" });

        expect(res.status).toBe(400);
    });

    it("previews an M3U file import with local library matching", async () => {
        const m3uPreview = {
            playlistName: "Road Trip",
            resolved: [
                { index: 0, artist: "Artist A", title: "Song A", source: "local", trackId: "track-1", confidence: 100 },
                { index: 1, artist: "Artist B", title: "Song B", source: "unresolved", confidence: 0 },
            ],
            summary: { total: 2, local: 1, youtube: 0, tidal: 0, unresolved: 1 },
        };
        mockPreviewM3UImport.mockResolvedValueOnce(m3uPreview);

        const res = await request(app)
            .post("/api/import/m3u/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                name: "Road Trip",
                content: "#EXTM3U\n#EXTINF:200,Artist A - Song A\n/music/a.flac\n#EXTINF:180,Artist B - Song B\n/music/b.flac",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(m3uPreview);
        expect(mockPreviewM3UImport).toHaveBeenCalledWith(
            "Road Trip",
            "#EXTM3U\n#EXTINF:200,Artist A - Song A\n/music/a.flac\n#EXTINF:180,Artist B - Song B\n/music/b.flac"
        );
    });

    it("rejects M3U preview when content is missing", async () => {
        const res = await request(app)
            .post("/api/import/m3u/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ name: "Test" });

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({ error: expect.stringMatching(/content/i) })
        );
        expect(mockPreviewM3UImport).not.toHaveBeenCalled();
    });

    it("rejects M3U preview when content exceeds size limit", async () => {
        const res = await request(app)
            .post("/api/import/m3u/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ name: "Huge", content: "x".repeat(2_000_001) });

        // Express body-parser rejects payloads over its limit (413) before the
        // route handler can apply its own check (400).  Either status is acceptable.
        expect([400, 413]).toContain(res.status);
        expect(mockPreviewM3UImport).not.toHaveBeenCalled();
    });

    it("uses a default name when M3U preview name is omitted", async () => {
        mockPreviewM3UImport.mockResolvedValueOnce({
            playlistName: "M3U import",
            resolved: [],
            summary: { total: 0, local: 0, youtube: 0, tidal: 0, unresolved: 0 },
        });

        const res = await request(app)
            .post("/api/import/m3u/preview")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({ content: "#EXTM3U\n" });

        expect(res.status).toBe(200);
        expect(mockPreviewM3UImport).toHaveBeenCalledWith("M3U import", "#EXTM3U\n");
    });

    it("executes imports with previewData and forwards response payload", async () => {
        const executeResult = {
            playlistId: "playlist-123",
            summary: {
                total: 2,
                local: 1,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
        };
        mockImportPlaylist.mockResolvedValueOnce(executeResult);

        const previewData = {
            playlistName: "Imported Playlist",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "local",
                    confidence: 100,
                    trackId: "track_1",
                },
                {
                    index: 1,
                    artist: "A2",
                    title: "T2",
                    source: "youtube",
                    confidence: 85,
                    trackYtMusicId: "cy_1",
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

        const res = await request(app)
            .post("/api/import/execute")
            .set(AUTH_HEADER, AUTH_VALUE)
            .send({
                previewData,
                name: "Custom Name",
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(executeResult);
        expect(mockImportPlaylist).toHaveBeenCalledWith(
            "user-1",
            previewData,
            "Custom Name"
        );
    });
});
