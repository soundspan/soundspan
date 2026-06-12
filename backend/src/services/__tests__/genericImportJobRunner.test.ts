jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../importJobStore", () => ({
    importJobStore: {
        getJob: jest.fn(),
        updateJob: jest.fn(),
    },
}));

jest.mock("../playlistImportService", () => ({
    playlistImportService: {
        previewImport: jest.fn(),
        importPlaylist: jest.fn(),
    },
}));

import { importJobStore } from "../importJobStore";
import { playlistImportService } from "../playlistImportService";
import { genericImportJobRunner } from "../genericImportJobRunner";

describe("generic import job runner", () => {
    const mockGetJob = importJobStore.getJob as jest.Mock;
    const mockUpdateJob = importJobStore.updateJob as jest.Mock;
    const mockPreviewImport = playlistImportService.previewImport as jest.Mock;
    const mockImportPlaylist = playlistImportService.importPlaylist as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("runs a pending import job through preview and playlist creation", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: "Roadtrip",
            status: "pending",
        });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [
                {
                    index: 0,
                    artist: "Artist",
                    title: "Song",
                    source: "local",
                    confidence: 100,
                    trackId: "track-1",
                },
            ],
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        mockImportPlaylist.mockResolvedValue({
            playlistId: "playlist-1",
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-1");

        expect(mockUpdateJob).toHaveBeenNthCalledWith(1, "job-1", {
            status: "resolving",
            progress: 20,
        });
        expect(mockPreviewImport).toHaveBeenCalledWith(
            "user-1",
            "https://open.spotify.com/playlist/abc"
        );
        expect(mockUpdateJob).toHaveBeenNthCalledWith(2, "job-1", {
            status: "creating_playlist",
            progress: 70,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Artist",
                    title: "Song",
                    source: "local",
                    confidence: 100,
                    trackId: "track-1",
                },
            ],
        });
        expect(mockImportPlaylist).toHaveBeenCalledWith(
            "user-1",
            {
                playlistName: "Weekend Mix",
                resolved: [
                    {
                        index: 0,
                        artist: "Artist",
                        title: "Song",
                        source: "local",
                        confidence: 100,
                        trackId: "track-1",
                    },
                ],
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            },
            "Roadtrip"
        );
        expect(mockUpdateJob).toHaveBeenNthCalledWith(3, "job-1", {
            status: "completed",
            progress: 100,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            createdPlaylistId: "playlist-1",
            error: null,
        });
    });

    it("marks the job failed when preview resolution throws", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        mockPreviewImport.mockRejectedValue(new Error("preview failed"));

        await genericImportJobRunner.runJob("job-1");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenLastCalledWith("job-1", {
            status: "failed",
            progress: 100,
            error: "preview failed",
        });
    });

    it("stops before playlist creation when the job is cancelled mid-flight", async () => {
        mockGetJob
            .mockResolvedValueOnce({
                id: "job-1",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-1",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-1",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelled",
            });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-1");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenCalledTimes(1);
        expect(mockUpdateJob).toHaveBeenCalledWith("job-1", {
            status: "resolving",
            progress: 20,
        });
    });

    it("marks the job cancelled when cancellation is requested before playlist creation starts", async () => {
        mockGetJob
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelling",
            })
            .mockResolvedValueOnce({
                id: "job-2",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelling",
                createdPlaylistId: null,
            });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-2");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockUpdateJob).toHaveBeenNthCalledWith(2, "job-2", {
            status: "cancelled",
            progress: 100,
            error: "Cancelled by user",
        });
    });

    it("records completion when cancellation arrives after playlist creation starts", async () => {
        mockGetJob
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            })
            .mockResolvedValueOnce({
                id: "job-3",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "cancelling",
            });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        mockImportPlaylist.mockResolvedValue({
            playlistId: "playlist-late",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-3");

        expect(mockUpdateJob).toHaveBeenLastCalledWith("job-3", {
            status: "completed",
            progress: 100,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            createdPlaylistId: "playlist-late",
            error: "Cancellation requested after playlist creation completed",
        });
    });
});
