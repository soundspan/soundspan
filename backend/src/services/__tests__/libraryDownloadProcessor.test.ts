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

jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: { startDownload: jest.fn() },
}));

const processSoulseekDownload = jest.fn();
jest.mock("../soulseekLibraryDownload", () => ({
    processSoulseekDownload: (...args: unknown[]) =>
        processSoulseekDownload(...args),
}));

jest.mock("../coalescedLibraryScan", () => ({
    requestCoalescedLibraryScan: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { requestCoalescedLibraryScan } from "../coalescedLibraryScan";
import {
    type LibraryAlbumDownloadOptions,
    type LibraryDownloadProcessorConfig,
    runLibraryAlbumDownload,
} from "../libraryDownloadProcessor";

interface FakeMatch {
    id: string;
}

interface FakeResult {
    downloaded: number;
}

const mockFindUnique = prisma.downloadJob.findUnique as jest.Mock;
const mockUpdate = prisma.downloadJob.update as jest.Mock;
const mockSettings = getSystemSettings as jest.Mock;
const mockScan = requestCoalescedLibraryScan as jest.Mock;
const findMatch = jest.fn<Promise<FakeMatch | null>, [string, string]>();
const download = jest.fn<Promise<FakeResult>, [FakeMatch, unknown]>();
type PeerRunArgs = [
    string,
    string,
    string,
    string,
    LibraryAlbumDownloadOptions & { isFallback: true },
];
const fallbackPeer = jest.fn<Promise<void>, PeerRunArgs>();

const processorConfig: LibraryDownloadProcessorConfig<FakeMatch, FakeResult> = {
    sourceKey: "fake",
    sourceLabel: "Fake Music",
    searchingStatusText: "Searching Fake Music...",
    failedError: "Fake download failed",
    failedStatusText: "Fake Music failed",
    findMatch,
    download,
    resultSummary: (_match, result) => ({
        statusText: `Fake Music ✓ ${result.downloaded} tracks`,
        metadata: { fakeResult: { downloaded: result.downloaded } },
    }),
    fallbackPeer: {
        sourceKey: "youtube",
        run: fallbackPeer,
    },
    logFallbackSelection: false,
    prefixManagerFailureLog: false,
    scanSource: "fake-download",
};

describe("libraryDownloadProcessor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockResolvedValue({
            metadata: {
                albumMbid: "rg-1",
                queuedVia: "album-download-queue",
                failedAt: "2026-08-24T10:00:00.000Z",
            },
        });
        mockUpdate.mockResolvedValue({});
        mockSettings.mockResolvedValue({ primaryFailureFallback: "none" });
        findMatch.mockResolvedValue({ id: "match-1" });
        download.mockResolvedValue({ downloaded: 3 });
        fallbackPeer.mockResolvedValue(undefined);
        mockScan.mockResolvedValue(undefined);
    });

    it("hands a search miss to the configured peer", async () => {
        findMatch.mockResolvedValueOnce(null);
        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { fallbackSource: "youtube" },
        );

        expect(fallbackPeer).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { isFallback: true },
        );
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                metadata: {
                    albumMbid: "rg-1",
                    queuedVia: "album-download-queue",
                    failedAt: "2026-08-24T10:00:00.000Z",
                    currentSource: "youtube",
                    statusText: "Fake Music not found → youtube",
                },
            },
        });
        expect(download).not.toHaveBeenCalled();
    });

    it("uses the resolved snapshot to hand a search miss to Soulseek", async () => {
        findMatch.mockResolvedValueOnce(null);
        mockSettings.mockResolvedValueOnce({
            primaryFailureFallback: "lidarr",
        });

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { fallbackSource: "soulseek" } as LibraryAlbumDownloadOptions,
        );

        expect(mockSettings).not.toHaveBeenCalled();
        expect(processSoulseekDownload).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                metadata: expect.objectContaining({
                    currentSource: "soulseek",
                    statusText: "Fake Music not found → soulseek",
                }),
            },
        });
    });

    it("marks a forwarded peer attempt as fallback and stops after both providers miss", async () => {
        const siblingFindMatch = jest
            .fn<Promise<FakeMatch | null>, [string, string]>()
            .mockResolvedValue(null);
        const recursivePeer = jest
            .fn<Promise<void>, PeerRunArgs>()
            .mockResolvedValue(undefined);
        const siblingConfig: LibraryDownloadProcessorConfig<
            FakeMatch,
            FakeResult
        > = {
            ...processorConfig,
            sourceKey: "youtube",
            sourceLabel: "Peer Music",
            findMatch: siblingFindMatch,
            fallbackPeer: {
                sourceKey: "youtube",
                run: recursivePeer,
            },
        };
        const siblingProcessor = jest.fn(
            async (...args: PeerRunArgs): Promise<void> => {
                await runLibraryAlbumDownload(siblingConfig, ...args);
            },
        );
        const primaryFindMatch = jest
            .fn<Promise<FakeMatch | null>, [string, string]>()
            .mockResolvedValue(null);
        const forwardingConfig: LibraryDownloadProcessorConfig<
            FakeMatch,
            FakeResult
        > = {
            ...processorConfig,
            findMatch: primaryFindMatch,
            fallbackPeer: {
                sourceKey: "youtube",
                run: (...args) => siblingProcessor(...args),
            },
        };
        await runLibraryAlbumDownload(
            forwardingConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { fallbackSource: "youtube" },
        );

        expect(siblingProcessor).toHaveBeenCalledWith(
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { isFallback: true },
        );
        expect(primaryFindMatch).toHaveBeenCalledTimes(1);
        expect(siblingFindMatch).toHaveBeenCalledTimes(1);
        expect(recursivePeer).not.toHaveBeenCalled();
    });

    it("persists a sanitized failure when the provider download fails", async () => {
        download.mockRejectedValueOnce(new Error("private dependency detail"));

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        const failedUpdate = mockUpdate.mock.calls.find(
            ([call]) => call.data?.status === "failed",
        )?.[0];
        expect(failedUpdate.data.error).toBe("Fake download failed");
        expect(failedUpdate.data.metadata).toEqual(
            expect.objectContaining({
                queuedVia: "album-download-queue",
                currentSource: "fake",
                statusText: "Fake Music failed",
                failedAt: expect.any(String),
            }),
        );
        expect(JSON.stringify(failedUpdate)).not.toContain(
            "private dependency detail",
        );
        expect(mockScan).not.toHaveBeenCalled();
    });

    it("completes the job and requests the configured library scan", async () => {
        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        const completedUpdate = mockUpdate.mock.calls.find(
            ([call]) => call.data?.status === "completed",
        )?.[0];
        expect(completedUpdate.data.error).toBeNull();
        expect(completedUpdate.data.metadata).toEqual(
            expect.objectContaining({
                queuedVia: "album-download-queue",
                currentSource: "fake",
                statusText: "Fake Music ✓ 3 tracks",
                fakeResult: { downloaded: 3 },
            }),
        );
        expect(completedUpdate.data.metadata).not.toHaveProperty("failedAt");
        expect(mockScan).toHaveBeenCalledWith("user-1", "fake-download");
    });

    it("does not hand a fallback search miss back to the peer", async () => {
        findMatch.mockResolvedValueOnce(null);
        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
            { isFallback: true, fallbackSource: "youtube" },
        );

        expect(fallbackPeer).not.toHaveBeenCalled();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: "failed",
                    error: "Fake download failed",
                }),
            }),
        );
    });
});
