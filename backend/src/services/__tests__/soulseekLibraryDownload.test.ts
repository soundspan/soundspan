const mockLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger: { child: jest.fn(() => mockLog) },
}));

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            update: (...args: unknown[]) => mockUpdate(...args),
        },
    },
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

const mockGetAlbumTracks = jest.fn();
const mockGetExpectedTrackCount = jest.fn();
jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        getAlbumTracks: (...args: unknown[]) => mockGetAlbumTracks(...args),
        getExpectedTrackCount: (...args: unknown[]) =>
            mockGetExpectedTrackCount(...args),
    },
}));

const mockGetAlbumInfo = jest.fn();
jest.mock("../lastfm", () => ({
    lastFmService: {
        getAlbumInfo: (...args: unknown[]) => mockGetAlbumInfo(...args),
    },
}));

const mockSearchAndDownloadBatch = jest.fn();
jest.mock("../soulseek", () => ({
    soulseekService: {
        searchAndDownloadBatch: (...args: unknown[]) =>
            mockSearchAndDownloadBatch(...args),
    },
}));

import { processSoulseekDownload } from "../soulseekLibraryDownload";

describe("processSoulseekDownload", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockResolvedValue({
            targetMbid: "rg-1",
            metadata: {},
        });
        mockUpdate.mockResolvedValue({});
        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
            soulseekConcurrentDownloads: 3,
        });
        mockGetAlbumTracks.mockResolvedValue([
            { title: "Track A", position: 1 },
            { title: "Track B", position: 2 },
        ]);
        mockGetExpectedTrackCount.mockResolvedValue(2);
        mockGetAlbumInfo.mockResolvedValue(null);
        mockSearchAndDownloadBatch.mockResolvedValue({
            successful: 2,
            errors: [],
        });
    });

    it("downloads requested tracks through Soulseek and completes the job", async () => {
        const requestedTracks = [{ title: "Only Track" }, { title: "Two" }];
        mockFindUnique.mockResolvedValue({
            targetMbid: "rg-1",
            metadata: { requestedTracks, soulseekAttempts: 1 },
        });

        await expect(
            processSoulseekDownload("303", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: true,
            source: "soulseek",
            downloadJobId: 303,
            tracksDownloaded: 2,
            tracksTotal: 2,
            error: undefined,
        });

        expect(mockGetExpectedTrackCount).toHaveBeenCalledWith("rg-1");
        expect(mockGetAlbumTracks).not.toHaveBeenCalled();
        expect(mockSearchAndDownloadBatch).toHaveBeenCalledWith(
            [
                { artist: "Artist", title: "Only Track", album: "Album" },
                { artist: "Artist", title: "Two", album: "Album" },
            ],
            "/music",
            3,
        );
        expect(mockUpdate).toHaveBeenLastCalledWith({
            where: { id: "303" },
            data: {
                status: "completed",
                error: null,
                completedAt: expect.any(Date),
                metadata: {
                    requestedTracks,
                    soulseekAttempts: 1,
                    expectedTracks: 2,
                    tracksDownloaded: 2,
                    tracksTotal: 2,
                },
            },
        });
    });

    it("uses Last.fm when MusicBrainz has no tracks and persists no-match failure", async () => {
        mockGetExpectedTrackCount.mockResolvedValueOnce(0);
        mockGetAlbumTracks.mockResolvedValueOnce([]);
        mockGetAlbumInfo.mockResolvedValueOnce({
            tracks: {
                track: [{ name: "LFM Track", "@attr": { rank: "1" } }],
            },
        });
        mockSearchAndDownloadBatch.mockResolvedValueOnce({
            successful: 0,
            errors: ["Artist - LFM Track: missing"],
        });

        await expect(
            processSoulseekDownload("401", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            tracksTotal: 1,
            downloadJobId: 401,
            error: "No tracks found on Soulseek (searched 1 tracks)",
        });

        expect(mockUpdate).toHaveBeenLastCalledWith({
            where: { id: "401" },
            data: {
                status: "failed",
                error: "No tracks found on Soulseek (searched 1 tracks)",
                completedAt: expect.any(Date),
            },
        });
    });

    it("persists missing-path and missing-MBID failures", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({ musicPath: "" });
        await expect(
            processSoulseekDownload("402", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            error: "Music path not configured",
        });

        mockFindUnique.mockResolvedValueOnce({
            targetMbid: "",
            metadata: {},
        });
        await expect(
            processSoulseekDownload("403", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            error: "Album MBID required for Soulseek download",
        });

        expect(mockSearchAndDownloadBatch).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenLastCalledWith({
            where: { id: "403" },
            data: {
                status: "failed",
                error: "Album MBID required for Soulseek download",
                completedAt: expect.any(Date),
            },
        });
    });

    it("persists empty track lists and partial downloads", async () => {
        mockGetExpectedTrackCount
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(4);
        mockGetAlbumTracks.mockResolvedValueOnce([]);
        mockGetAlbumInfo.mockResolvedValueOnce({ tracks: { track: [] } });
        await expect(
            processSoulseekDownload("404", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            error: "Could not get track list from MusicBrainz or Last.fm",
        });

        mockGetAlbumTracks.mockResolvedValueOnce([
            { title: "Track 1" },
            { title: "Track 2" },
            { title: "Track 3" },
            { title: "Track 4" },
        ]);
        mockSearchAndDownloadBatch.mockResolvedValueOnce({
            successful: 2,
            errors: ["two unavailable tracks"],
        });
        await expect(
            processSoulseekDownload("405", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            source: "soulseek",
            downloadJobId: 405,
            tracksDownloaded: 2,
            tracksTotal: 4,
            error: "Partial download: 2/4 tracks",
        });
        expect(mockUpdate).toHaveBeenLastCalledWith({
            where: { id: "405" },
            data: {
                status: "failed",
                error: "Partial download: 2/4 tracks",
                completedAt: expect.any(Date),
                metadata: {
                    currentSource: "soulseek",
                    expectedTracks: 4,
                    failedAt: expect.any(String),
                    partial: true,
                    statusText: "Partial download: 2/4 tracks",
                    tracksDownloaded: 2,
                    tracksTotal: 4,
                },
            },
        });
    });

    it("persists unexpected Soulseek failures and returns without throwing", async () => {
        const rawDetail = "Soulseek network failed for user secret-token";
        const failure = new Error(rawDetail);
        mockSearchAndDownloadBatch.mockRejectedValueOnce(failure);

        await expect(
            processSoulseekDownload("501", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            error: "Soulseek download failed",
        });

        expect(mockUpdate).toHaveBeenLastCalledWith({
            where: { id: "501" },
            data: {
                status: "failed",
                error: "Soulseek download failed",
                completedAt: expect.any(Date),
            },
        });
        expect(JSON.stringify(mockUpdate.mock.calls)).not.toContain(rawDetail);
        expect(mockLog.error).toHaveBeenCalledWith(
            "Soulseek album download failed",
            { jobId: "501", error: failure },
        );
        expect(mockSearchAndDownloadBatch).toHaveBeenCalledTimes(1);
    });

    it("returns a safe failure when the attempt status write is rejected", async () => {
        const rawDetail = "attempt status write exposed row contents";
        mockUpdate.mockRejectedValueOnce(new Error(rawDetail));

        await expect(
            processSoulseekDownload("502", "Artist", "Album", "user-1"),
        ).resolves.toEqual({
            success: false,
            error: "Soulseek download failed",
        });

        expect(mockUpdate).toHaveBeenLastCalledWith({
            where: { id: "502" },
            data: {
                status: "failed",
                error: "Soulseek download failed",
                completedAt: expect.any(Date),
            },
        });
        expect(JSON.stringify(mockUpdate.mock.calls)).not.toContain(rawDetail);
    });
});
