const mockLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => mockLog),
    },
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

const mockLidarrAvailable = jest.fn();
jest.mock("../lidarr", () => ({
    lidarrService: {
        isEnabled: (...args: unknown[]) => mockLidarrAvailable(...args),
    },
}));

const mockSoulseekAvailable = jest.fn();
jest.mock("../soulseek", () => ({
    soulseekService: {
        isAvailable: (...args: unknown[]) => mockSoulseekAvailable(...args),
    },
}));

const mockTidalAvailable = jest.fn();
jest.mock("../tidal", () => ({
    tidalService: {
        isAvailable: (...args: unknown[]) => mockTidalAvailable(...args),
    },
}));

const mockYoutubeAvailable = jest.fn();
jest.mock("../youtubeDownload", () => ({
    youtubeDownloadService: {
        isAvailable: (...args: unknown[]) => mockYoutubeAvailable(...args),
    },
}));

const mockProcessTidalDownload = jest.fn();
jest.mock("../tidalLibraryDownload", () => ({
    processTidalDownload: (...args: unknown[]) =>
        mockProcessTidalDownload(...args),
}));

const mockProcessYoutubeDownload = jest.fn();
jest.mock("../youtubeLibraryDownload", () => ({
    processYoutubeDownload: (...args: unknown[]) =>
        mockProcessYoutubeDownload(...args),
}));

const mockStartDownload = jest.fn();
jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: {
        startDownload: (...args: unknown[]) => mockStartDownload(...args),
    },
}));

import {
    dispatchAlbumDownload,
    dispatchResolvedAlbumDownload,
    resolveAlbumDownloadRouting,
} from "../downloadDispatcher";

const baseParams = {
    jobId: "job-1",
    type: "album",
    mbid: "rg-1",
    subject: "Artist - Album",
    artistName: "Artist",
    albumTitle: "Album",
};

describe("dispatchAlbumDownload", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            metadata: { preserved: true },
        });
        mockUpdate.mockResolvedValue({});
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "soulseek",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(false);
        mockLidarrAvailable.mockResolvedValue(true);
        mockSoulseekAvailable.mockResolvedValue(true);
        mockYoutubeAvailable.mockResolvedValue(false);
        mockProcessTidalDownload.mockResolvedValue(undefined);
        mockProcessYoutubeDownload.mockResolvedValue(undefined);
        mockStartDownload.mockResolvedValue({ success: true });
    });

    it("dispatches an available configured YouTube source", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "youtube",
            primaryFailureFallback: "none",
        });
        mockYoutubeAvailable.mockResolvedValue(true);

        await dispatchAlbumDownload(baseParams);

        expect(mockProcessYoutubeDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );
        expect(mockStartDownload).not.toHaveBeenCalled();
    });

    it("dispatches an available configured TIDAL source", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(true);

        await dispatchAlbumDownload(baseParams);

        expect(mockProcessTidalDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );
        expect(mockTidalAvailable).toHaveBeenCalledTimes(1);
        expect(mockLidarrAvailable).toHaveBeenCalledTimes(1);
        expect(mockSoulseekAvailable).toHaveBeenCalledTimes(1);
        expect(mockYoutubeAvailable).toHaveBeenCalledTimes(1);
        expect(mockStartDownload).not.toHaveBeenCalled();
    });

    it("dispatches a resolved routing snapshot without probing sources twice", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });
        mockTidalAvailable.mockResolvedValue(true);
        const routing = await resolveAlbumDownloadRouting(baseParams);

        await dispatchResolvedAlbumDownload(routing, baseParams);

        expect(mockGetSystemSettings).toHaveBeenCalledTimes(1);
        expect(mockTidalAvailable).toHaveBeenCalledTimes(1);
        expect(mockLidarrAvailable).toHaveBeenCalledTimes(1);
        expect(mockSoulseekAvailable).toHaveBeenCalledTimes(1);
        expect(mockYoutubeAvailable).toHaveBeenCalledTimes(1);
        expect(mockProcessTidalDownload).toHaveBeenCalledTimes(1);
    });

    it("uses YouTube as an available explicit fallback", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "tidal",
            primaryFailureFallback: "youtube",
        });
        mockYoutubeAvailable.mockResolvedValue(true);

        await dispatchAlbumDownload(baseParams);

        expect(mockProcessYoutubeDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );
    });

    it("falls back from unavailable YouTube to the manager-backed Soulseek path", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "youtube",
            primaryFailureFallback: "soulseek",
        });

        await dispatchAlbumDownload(baseParams);

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "rg-1",
            "user-1",
        );
        expect(mockProcessYoutubeDownload).not.toHaveBeenCalled();
    });

    it("uses the manager for an available configured Soulseek source", async () => {
        await dispatchAlbumDownload({
            ...baseParams,
            artistName: undefined,
            albumTitle: undefined,
            subject: "Split Artist - Split - Album",
        });

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-1",
            "Split Artist",
            "Split - Album",
            "rg-1",
            "user-1",
        );
    });

    it("passes a supplied artist MBID to the manager-backed source", async () => {
        await dispatchAlbumDownload({
            ...baseParams,
            artistMbid: "artist-mbid-1",
        });

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "rg-1",
            "user-1",
            false,
            "artist-mbid-1",
        );
    });

    it("uses the subject for both names when no delimiter or metadata exists", async () => {
        await dispatchAlbumDownload({
            ...baseParams,
            artistName: undefined,
            albumTitle: undefined,
            subject: "SingleSubject",
        });

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-1",
            "SingleSubject",
            "SingleSubject",
            "rg-1",
            "user-1",
        );
    });

    it("logs unsuccessful manager starts without throwing", async () => {
        mockStartDownload.mockResolvedValueOnce({
            success: false,
            error: "unavailable indexer",
        });

        await dispatchAlbumDownload(baseParams);

        expect(mockLog.error).toHaveBeenCalledWith(
            "Failed to start download: unavailable indexer",
        );
    });

    it("fails without dispatch when the unavailable primary uses Skip", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "tidal",
            primaryFailureFallback: "none",
        });

        await dispatchAlbumDownload(baseParams);

        expect(mockProcessTidalDownload).not.toHaveBeenCalled();
        expect(mockStartDownload).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                status: "failed",
                error: 'tidal is unavailable and "When primary source fails" is set to Skip',
                completedAt: expect.any(Date),
                metadata: {
                    preserved: true,
                    currentSource: "tidal",
                    statusText: "tidal unavailable — skipped",
                    failedAt: expect.any(String),
                },
            },
        });
    });

    it("uses the explicitly configured manager fallback", async () => {
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "tidal",
            primaryFailureFallback: "lidarr",
        });

        await dispatchAlbumDownload(baseParams);

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "rg-1",
            "user-1",
        );
    });

    it("fails when both the primary and configured fallback are unavailable", async () => {
        mockFindUnique.mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
            metadata: "scalar metadata",
        });
        mockGetSystemSettings.mockResolvedValue({
            downloadSource: "tidal",
            primaryFailureFallback: "lidarr",
        });
        mockLidarrAvailable.mockResolvedValue(false);

        await dispatchAlbumDownload(baseParams);

        expect(mockStartDownload).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                status: "failed",
                error: "tidal is unavailable and the configured fallback (lidarr) is also unavailable",
                completedAt: expect.any(Date),
                metadata: {
                    currentSource: "tidal",
                    statusText: "tidal and fallback lidarr unavailable",
                    failedAt: expect.any(String),
                },
            },
        });
    });

    it("preserves the legacy availability ladder when fallback is absent", async () => {
        mockGetSystemSettings.mockResolvedValue({ downloadSource: "tidal" });

        await dispatchAlbumDownload(baseParams);

        expect(mockStartDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "rg-1",
            "user-1",
        );
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("returns without probing sources when the job no longer exists", async () => {
        mockFindUnique.mockResolvedValueOnce(null);

        await dispatchAlbumDownload(baseParams);

        expect(mockGetSystemSettings).not.toHaveBeenCalled();
        expect(mockLog.error).toHaveBeenCalledWith("Job job-1 not found");
    });

    it("leaves non-album jobs undispatched", async () => {
        await dispatchAlbumDownload({ ...baseParams, type: "artist" });

        expect(mockGetSystemSettings).not.toHaveBeenCalled();
        expect(mockStartDownload).not.toHaveBeenCalled();
    });
});
