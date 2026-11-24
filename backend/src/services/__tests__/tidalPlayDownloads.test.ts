const mockStartPlayDownload = jest.fn();
const mockGetPlayDownloadResult = jest.fn();
jest.mock("../tidal", () => ({
    tidalService: {
        startPlayDownload: mockStartPlayDownload,
        getPlayDownloadResult: mockGetPlayDownloadResult,
    },
}));

const mockPrisma = {
    tidalPlayDownload: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
    },
    userSettings: {
        findUnique: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

const mockRequestScan = jest.fn();
jest.mock("../libraryFileScan", () => ({
    requestLibraryFileScan: mockRequestScan,
}));

const mockStat = jest.fn();
jest.mock("node:fs", () => ({
    promises: { stat: mockStat },
}));

const mockParseFile = jest.fn();
jest.mock("music-metadata", () => ({ parseFile: mockParseFile }), {
    virtual: true,
});

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

jest.mock("../audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));

import {
    awaitTidalPlayDownload,
    findTidalPlayDownload,
    isTidalPlayDownloadEnabled,
    openTidalPlayDownload,
    resolveTidalPlayDownloadQuality,
    tidalPlayDownloadInfo,
    tidalPlayDownloadStartInfo,
    tidalPlayDownloadStreamInfo,
} from "../tidalPlayDownloads";

const MODIFIED = new Date("2026-11-06T12:00:00.000Z");
const INFO = {
    contentType: "audio/mp4",
    quality: "HI_RES_LOSSLESS",
    codec: "flac",
    bitDepth: 24,
    sampleRate: 96000,
};
const RESULT = {
    track_id: 42,
    quality: "HI_RES_LOSSLESS",
    relative_path: "Artist/Album/01. Song.flac",
};

function fakeStream() {
    return { destroy: jest.fn(), pipe: jest.fn() };
}

describe("TIDAL download-as-you-play", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.tidalPlayDownload.findUnique.mockResolvedValue(null);
        mockPrisma.tidalPlayDownload.upsert.mockResolvedValue({});
        mockPrisma.tidalPlayDownload.update.mockResolvedValue({});
        mockRequestScan.mockResolvedValue(undefined);
        mockStat.mockResolvedValue({ mtime: MODIFIED });
        mockParseFile.mockResolvedValue({
            format: { codec: "FLAC", bitsPerSample: 24, sampleRate: 96000 },
        });
        mockStartPlayDownload.mockImplementation(async () => ({
            stream: fakeStream(),
            downloadId: "dl-42",
            info: INFO,
        }));
        mockGetPlayDownloadResult.mockResolvedValue(RESULT);
    });

    it("is enabled only when TIDAL and the admin toggle are both on", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            tidalEnabled: true,
            tidalDownloadBeforePlay: false,
        });
        await expect(isTidalPlayDownloadEnabled()).resolves.toBe(false);

        mockGetSystemSettings.mockResolvedValueOnce({
            tidalEnabled: false,
            tidalDownloadBeforePlay: true,
        });
        await expect(isTidalPlayDownloadEnabled()).resolves.toBe(false);

        mockGetSystemSettings.mockResolvedValueOnce({
            tidalEnabled: true,
            tidalDownloadBeforePlay: true,
        });
        await expect(isTidalPlayDownloadEnabled()).resolves.toBe(true);
    });

    it("streams a new song from its download and records the installed file", async () => {
        const { stream, info } = await openTidalPlayDownload(42, "user-1");

        expect(mockStartPlayDownload).toHaveBeenCalledWith(
            42,
            "HI_RES_LOSSLESS",
        );
        expect(info).toEqual(INFO);
        expect(stream).toBeDefined();

        const file = await awaitTidalPlayDownload(42, "user-1");

        expect(mockGetPlayDownloadResult).toHaveBeenCalledWith("dl-42");
        expect(file).toEqual({
            tidalId: 42,
            absolutePath: "/music/Artist/Album/01. Song.flac",
            fileModified: MODIFIED,
            quality: "HI_RES_LOSSLESS",
            codec: "FLAC",
            bitDepth: 24,
            sampleRate: 96000,
        });
        expect(mockPrisma.tidalPlayDownload.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tidalId: 42 },
                create: expect.objectContaining({
                    tidalId: 42,
                    relativePath: "Artist/Album/01. Song.flac",
                    quality: "HI_RES_LOSSLESS",
                }),
            }),
        );
        expect(mockRequestScan).toHaveBeenCalledWith(
            "user-1",
            ["Artist/Album/01. Song.flac"],
            "tidal-play-download",
        );
    });

    it("records a download once when several listeners join it", async () => {
        let install!: (value: unknown) => void;
        mockGetPlayDownloadResult.mockReturnValueOnce(
            new Promise((resolve) => {
                install = resolve;
            }),
        );

        await openTidalPlayDownload(42, "user-1");
        await openTidalPlayDownload(42, "user-2");
        install(RESULT);
        await awaitTidalPlayDownload(42, "user-1");

        expect(mockStartPlayDownload).toHaveBeenCalledTimes(2);
        expect(mockGetPlayDownloadResult).toHaveBeenCalledTimes(1);
        expect(mockPrisma.tidalPlayDownload.upsert).toHaveBeenCalledTimes(1);
    });

    it("reports a running download's format without opening it again", async () => {
        let install!: (value: unknown) => void;
        mockGetPlayDownloadResult.mockReturnValueOnce(
            new Promise((resolve) => {
                install = resolve;
            }),
        );
        await openTidalPlayDownload(42, "user-1");

        await expect(tidalPlayDownloadInfo(42, "user-1")).resolves.toEqual(
            INFO,
        );

        expect(mockStartPlayDownload).toHaveBeenCalledTimes(1);
        install(RESULT);
        await awaitTidalPlayDownload(42, "user-1");
    });

    it("starts a download for its format without reading the audio", async () => {
        const stream = fakeStream();
        mockStartPlayDownload.mockResolvedValueOnce({
            stream,
            downloadId: "dl-42",
            info: INFO,
        });

        await expect(tidalPlayDownloadInfo(42, "user-1")).resolves.toEqual(
            INFO,
        );

        expect(stream.destroy).toHaveBeenCalled();
        await awaitTidalPlayDownload(42, "user-1");
        expect(mockPrisma.tidalPlayDownload.upsert).toHaveBeenCalled();
    });

    it("downloads a whole song for a seek before it streamed that far", async () => {
        const stream = fakeStream();
        mockStartPlayDownload.mockResolvedValueOnce({
            stream,
            downloadId: "dl-42",
            info: INFO,
        });

        const file = await awaitTidalPlayDownload(42, "user-1");

        expect(stream.destroy).toHaveBeenCalled();
        expect(file?.absolutePath).toBe("/music/Artist/Album/01. Song.flac");
    });

    it("settles to null and records nothing when the download fails", async () => {
        mockGetPlayDownloadResult.mockRejectedValueOnce(
            new Error("sidecar down"),
        );

        await openTidalPlayDownload(42, "user-1");

        await expect(awaitTidalPlayDownload(42, "user-1")).resolves.toBeNull();
        expect(mockPrisma.tidalPlayDownload.upsert).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("refuses a download path outside the music folder", async () => {
        mockGetPlayDownloadResult.mockResolvedValueOnce({
            ...RESULT,
            relative_path: "../../etc/passwd",
        });

        await expect(awaitTidalPlayDownload(42, "user-1")).resolves.toBeNull();
        expect(mockPrisma.tidalPlayDownload.upsert).not.toHaveBeenCalled();
    });

    it("keeps the download when its audio format cannot be read", async () => {
        mockParseFile.mockRejectedValueOnce(new Error("bad header"));

        const file = await awaitTidalPlayDownload(42, "user-1");

        expect(file).toEqual(
            expect.objectContaining({
                codec: "FLAC",
                bitDepth: null,
                sampleRate: null,
            }),
        );
    });

    it("reuses a recorded file and marks it played", async () => {
        mockPrisma.tidalPlayDownload.findUnique.mockResolvedValueOnce({
            tidalId: 42,
            relativePath: "Artist/Album/01. Song.flac",
            quality: "LOSSLESS",
            codec: "FLAC",
            bitDepth: 16,
            sampleRate: 44100,
        });

        const file = await findTidalPlayDownload(42);

        expect(file).toEqual(
            expect.objectContaining({
                absolutePath: "/music/Artist/Album/01. Song.flac",
                quality: "LOSSLESS",
                bitDepth: 16,
            }),
        );
        expect(mockStartPlayDownload).not.toHaveBeenCalled();
        expect(mockPrisma.tidalPlayDownload.update).toHaveBeenCalledWith({
            where: { tidalId: 42 },
            data: { lastPlayedAt: expect.any(Date) },
        });
    });

    it("finds nothing for a song never downloaded or whose file is gone", async () => {
        await expect(findTidalPlayDownload(42)).resolves.toBeNull();

        mockPrisma.tidalPlayDownload.findUnique.mockResolvedValueOnce({
            tidalId: 42,
            relativePath: "Artist/Album/01. Song.flac",
            quality: "LOSSLESS",
            codec: "FLAC",
            bitDepth: 16,
            sampleRate: 44100,
        });
        mockStat.mockRejectedValueOnce(
            Object.assign(new Error("missing"), { code: "ENOENT" }),
        );
        await expect(findTidalPlayDownload(42)).resolves.toBeNull();
        expect(mockPrisma.tidalPlayDownload.update).not.toHaveBeenCalled();
    });

    it("uses the user's Playback quality for the downloaded file", async () => {
        mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
            playbackQuality: "original",
        });
        await expect(resolveTidalPlayDownloadQuality("user-1")).resolves.toBe(
            "original",
        );

        mockPrisma.userSettings.findUnique.mockResolvedValueOnce(null);
        await expect(resolveTidalPlayDownloadQuality("user-2")).resolves.toBe(
            "medium",
        );
    });

    it("describes a downloading song from its download's headers", () => {
        expect(tidalPlayDownloadStartInfo(42, INFO)).toEqual({
            trackId: 42,
            quality: "HI_RES_LOSSLESS",
            acodec: "flac",
            content_type: "audio/mp4",
            bit_depth: 24,
            sample_rate: 96000,
        });
    });

    it("describes the original file or the transcode that will be served", () => {
        const file = {
            tidalId: 42,
            absolutePath: "/music/a.flac",
            fileModified: MODIFIED,
            quality: "HI_RES_LOSSLESS",
            codec: "FLAC",
            bitDepth: 24,
            sampleRate: 96000,
        };

        expect(tidalPlayDownloadStreamInfo(file, "original")).toEqual({
            trackId: 42,
            quality: "HI_RES_LOSSLESS",
            acodec: "FLAC",
            content_type: "audio/flac",
            bit_depth: 24,
            sample_rate: 96000,
        });
        expect(tidalPlayDownloadStreamInfo(file, "high")).toEqual({
            trackId: 42,
            quality: "HIGH",
            acodec: "MP3",
            content_type: "audio/mpeg",
        });
    });
});
