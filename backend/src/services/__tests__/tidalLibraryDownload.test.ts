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
        downloadJob: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../tidal", () => ({
    tidalService: {
        findAlbum: jest.fn(),
        downloadAlbum: jest.fn(),
    },
}));

jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: { startDownload: jest.fn() },
}));

jest.mock("../youtubeLibraryDownload", () => ({
    processYoutubeDownload: jest.fn(),
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { scanQueue } from "../../workers/queues";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { tidalService } from "../tidal";
import { processYoutubeDownload } from "../youtubeLibraryDownload";
import { processTidalDownload } from "../tidalLibraryDownload";

const mockFindUnique = prisma.downloadJob.findUnique as jest.Mock;
const mockUpdate = prisma.downloadJob.update as jest.Mock;
const mockSettings = getSystemSettings as jest.Mock;
const mockFindAlbum = tidalService.findAlbum as jest.Mock;
const mockDownloadAlbum = tidalService.downloadAlbum as jest.Mock;
const mockFallback = simpleDownloadManager.startDownload as jest.Mock;
const mockProcessYoutubeDownload = processYoutubeDownload as jest.Mock;
const mockScan = scanQueue.add as jest.Mock;

describe("tidalLibraryDownload", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockResolvedValue({
            metadata: { albumMbid: "rg-1", retained: true },
        });
        mockUpdate.mockResolvedValue({});
        mockSettings.mockResolvedValue({ primaryFailureFallback: "none" });
        mockFindAlbum.mockResolvedValue({
            albumId: 123,
            title: "Album",
            artist: "Artist",
            numberOfTracks: 10,
        });
        mockDownloadAlbum.mockResolvedValue({
            album_id: 123,
            album_title: "Album",
            artist: "Artist",
            total_tracks: 10,
            downloaded: 9,
            failed: 1,
            tracks: [],
            errors: [],
        });
        mockFallback.mockResolvedValue({ success: true });
        mockProcessYoutubeDownload.mockResolvedValue(undefined);
        mockScan.mockResolvedValue(undefined);
    });

    it("completes the job and queues a tidal-download library scan", async () => {
        await processTidalDownload("job-1", "Artist", "Album", "user-1");

        expect(mockDownloadAlbum).toHaveBeenCalledWith(123);
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        currentSource: "tidal",
                        statusText: "TIDAL ✓ 9/10 tracks (1 failed)",
                    }),
                }),
            }),
        );
        expect(mockScan).toHaveBeenCalledWith("scan", {
            userId: "user-1",
            source: "tidal-download",
            artistName: "Artist",
            albumTitle: "Album",
        });
    });

    it("hands a search miss to a configured youtube fallback", async () => {
        mockFindAlbum.mockResolvedValueOnce(null);
        mockSettings.mockResolvedValueOnce({
            primaryFailureFallback: "youtube",
        });

        await processTidalDownload("job-1", "Artist", "Album", "user-1");

        expect(mockProcessYoutubeDownload).toHaveBeenCalledWith(
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
                        currentSource: "youtube",
                        statusText: "TIDAL not found → youtube",
                    }),
                }),
            }),
        );
        expect(mockDownloadAlbum).not.toHaveBeenCalled();
    });

    it("does not hand a youtube fallback back to youtube on another search miss", async () => {
        mockFindAlbum.mockResolvedValueOnce(null);
        mockSettings.mockResolvedValueOnce({
            primaryFailureFallback: "youtube",
        });

        await processTidalDownload("job-1", "Artist", "Album", "user-1", {
            isFallback: true,
        });

        expect(mockProcessYoutubeDownload).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-1" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "TIDAL download failed",
                }),
            }),
        );
    });
});
