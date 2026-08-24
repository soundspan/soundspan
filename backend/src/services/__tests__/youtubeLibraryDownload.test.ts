const mockLoggerWarn = jest.fn();

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: mockLoggerWarn,
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../youtubeDownload", () => ({
    youtubeDownloadService: {
        searchAlbums: jest.fn(),
        startAlbumDownload: jest.fn(),
        getAlbumDownloadJobStatus: jest.fn(),
    },
    watchYouTubeDownloadJobUntilTerminal: jest.fn(),
}));

jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: { startDownload: jest.fn() },
}));

jest.mock("../tidalLibraryDownload", () => ({
    processTidalDownload: jest.fn(),
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { scanQueue } from "../../workers/queues";
import { simpleDownloadManager } from "../simpleDownloadManager";
import {
    watchYouTubeDownloadJobUntilTerminal,
    youtubeDownloadService,
} from "../youtubeDownload";
import { processTidalDownload } from "../tidalLibraryDownload";
import {
    findAlbumBrowseId,
    processYoutubeDownload,
} from "../youtubeLibraryDownload";

const mockFindUnique = prisma.downloadJob.findUnique as jest.Mock;
const mockUpdate = prisma.downloadJob.update as jest.Mock;
const mockSettings = getSystemSettings as jest.Mock;
const mockSearch = youtubeDownloadService.searchAlbums as jest.Mock;
const mockStartAlbum = youtubeDownloadService.startAlbumDownload as jest.Mock;
const mockGetAlbumStatus =
    youtubeDownloadService.getAlbumDownloadJobStatus as jest.Mock;
const mockWatch = watchYouTubeDownloadJobUntilTerminal as jest.Mock;
const mockFallback = simpleDownloadManager.startDownload as jest.Mock;
const mockProcessTidalDownload = processTidalDownload as jest.Mock;
const mockScan = scanQueue.add as jest.Mock;

const completedStatus = {
    jobId: "sidecar-1",
    browseId: "MPRE123",
    status: "completed",
    progressPct: 100,
    albumTitle: "Album",
    albumArtist: "Artist",
    totalTracks: 10,
    downloaded: 9,
    failed: 1,
    errors: [],
    error: null,
    createdAt: 1,
};

describe("youtubeLibraryDownload", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockResolvedValue({
            metadata: { albumMbid: "rg-1", retained: true },
        });
        mockUpdate.mockResolvedValue({});
        mockSettings.mockResolvedValue({ primaryFailureFallback: "none" });
        mockSearch.mockResolvedValue([
            { browseId: "MPRE123", title: "Album", artists: ["Artist"] },
        ]);
        mockStartAlbum.mockResolvedValue({
            jobId: "sidecar-1",
            status: "queued",
        });
        mockWatch.mockResolvedValue("completed");
        mockGetAlbumStatus.mockResolvedValue(completedStatus);
        mockFallback.mockResolvedValue({ success: true });
        mockScan.mockResolvedValue(undefined);
    });

    it("prefers an exact normalized title and artist match", async () => {
        mockSearch.mockResolvedValueOnce([
            {
                browseId: "LOOSE",
                title: "Album Deluxe",
                artists: ["Artist"],
            },
            {
                browseId: "EXACT",
                title: "Al-bum",
                artists: ["Ar tist"],
            },
        ]);

        await expect(findAlbumBrowseId("Artist", "Album")).resolves.toBe(
            "EXACT",
        );
        expect(mockSearch).toHaveBeenCalledWith("Artist Album");
    });

    it("falls back to an exact normalized title match", async () => {
        mockSearch.mockResolvedValueOnce([
            {
                browseId: "LOOSE",
                title: "Album Deluxe",
                artists: ["Artist"],
            },
            {
                browseId: "TITLE",
                title: "Al-bum",
                artists: ["Different Artist"],
            },
        ]);

        await expect(findAlbumBrowseId("Artist", "Album")).resolves.toBe(
            "TITLE",
        );
    });

    it("falls back to the first result carrying a browse id", async () => {
        mockSearch.mockResolvedValueOnce([
            { title: "No Identifier", artists: ["Artist"] },
            {
                browseId: "FIRST",
                title: "Loose Result",
                artists: ["Different Artist"],
            },
            {
                browseId: "SECOND",
                title: "Another Result",
                artists: ["Artist"],
            },
        ]);

        await expect(findAlbumBrowseId("Artist", "Album")).resolves.toBe(
            "FIRST",
        );
    });

    it("returns null when no result carries a browse id", async () => {
        mockSearch.mockResolvedValueOnce([
            { title: "Album", artists: ["Artist"] },
            { browseId: "", title: "Album", artists: ["Artist"] },
        ]);

        await expect(findAlbumBrowseId("Artist", "Album")).resolves.toBeNull();
    });

    it("completes the job and queues a youtube-download library scan", async () => {
        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        expect(mockStartAlbum).toHaveBeenCalledWith("MPRE123");
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        currentSource: "youtube",
                        statusText: "YouTube Music ✓ 9/10 tracks",
                        youtubeResult: {
                            downloaded: 9,
                            failed: 1,
                            totalTracks: 10,
                        },
                    }),
                }),
            }),
        );
        expect(mockScan).toHaveBeenCalledWith("scan", {
            userId: "user-1",
            source: "youtube-download",
            artistName: "Artist",
            albumTitle: "Album",
        });
    });

    it("clears the first-attempt failure state after a successful retry", async () => {
        mockFindUnique.mockResolvedValueOnce({
            metadata: {
                albumMbid: "rg-1",
                retained: true,
                failedAt: "2026-08-24T10:00:00.000Z",
            },
        });

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        const searchingUpdate = mockUpdate.mock.calls.find(
            ([call]) =>
                call.data?.metadata?.statusText ===
                "Searching YouTube Music...",
        )?.[0];
        const completedUpdate = mockUpdate.mock.calls.find(
            ([call]) => call.data?.status === "completed",
        )?.[0];
        expect(searchingUpdate.data.error).toBeNull();
        expect(completedUpdate.data.error).toBeNull();
        expect(completedUpdate.data.metadata).toEqual(
            expect.objectContaining({ retained: true }),
        );
        expect(completedUpdate.data.metadata).not.toHaveProperty("failedAt");
    });

    it("keeps a completed download completed when scan admission fails", async () => {
        const scanError = new Error("scan queue unavailable");
        mockScan.mockRejectedValueOnce(scanError);

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        expect(
            mockUpdate.mock.calls.some(
                ([call]) => call.data?.status === "failed",
            ),
        ).toBe(false);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "YouTube Music library scan enqueue failed; download remains completed",
            { jobId: "job-1", error: scanError },
        );
    });

    it("persists progress only when the reported percentage changes", async () => {
        mockWatch.mockImplementationOnce(
            async (_jobId: string, _getStatus: unknown, options: any) => {
                await options.onStatus({ progressPct: 10 });
                await options.onStatus({ progressPct: 10 });
                await options.onStatus({ progressPct: 55 });
                return "completed";
            },
        );

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        const statusTexts = mockUpdate.mock.calls.map(
            ([request]) => request.data.metadata?.statusText,
        );
        expect(
            statusTexts.filter((text) => text === "YouTube Music 10%"),
        ).toHaveLength(1);
        expect(
            statusTexts.filter((text) => text === "YouTube Music 55%"),
        ).toHaveLength(1);
    });

    it("hands a search miss to a configured lidarr fallback", async () => {
        mockSearch.mockResolvedValueOnce([]);
        mockSettings.mockResolvedValueOnce({
            primaryFailureFallback: "lidarr",
        });

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        expect(mockFallback).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "rg-1",
            "user-1",
        );
        expect(mockStartAlbum).not.toHaveBeenCalled();
    });

    it("hands a search miss to a configured tidal fallback", async () => {
        mockSearch.mockResolvedValueOnce([]);
        mockSettings.mockResolvedValueOnce({
            primaryFailureFallback: "tidal",
        });

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        expect(mockProcessTidalDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { isFallback: true },
        );
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: expect.objectContaining({
                    metadata: expect.objectContaining({
                        currentSource: "tidal",
                        statusText: "YouTube Music not found → tidal",
                    }),
                }),
            }),
        );
    });

    it("does not bounce a tidal fallback back to tidal on another search miss", async () => {
        mockSearch.mockResolvedValueOnce([]);
        mockSettings.mockResolvedValueOnce({
            primaryFailureFallback: "tidal",
        });

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1", {
            isFallback: true,
        });

        expect(mockProcessTidalDownload).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "YouTube download failed",
                }),
            }),
        );
    });

    it("persists only a sanitized error when album search misses", async () => {
        mockSearch.mockResolvedValueOnce([]);

        await processYoutubeDownload(
            "job-1",
            "Artist",
            "Secret Album",
            "user-1",
        );

        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "failed",
                    error: "YouTube download failed",
                    metadata: expect.objectContaining({
                        statusText: "YouTube Music failed",
                    }),
                }),
            }),
        );
        expect(JSON.stringify(mockUpdate.mock.calls)).not.toContain(
            "Album not found on YouTube Music",
        );
    });

    it("fails a completed sidecar job that downloaded zero tracks", async () => {
        mockGetAlbumStatus.mockResolvedValueOnce({
            ...completedStatus,
            downloaded: 0,
            failed: 10,
        });

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "failed",
                    error: "YouTube download failed",
                }),
            }),
        );
        expect(mockScan).not.toHaveBeenCalled();
    });

    it("fails when the watched sidecar job is gone", async () => {
        mockWatch.mockResolvedValueOnce("gone");

        await processYoutubeDownload("job-1", "Artist", "Album", "user-1");

        expect(mockGetAlbumStatus).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "failed",
                    error: "YouTube download failed",
                }),
            }),
        );
    });
});
