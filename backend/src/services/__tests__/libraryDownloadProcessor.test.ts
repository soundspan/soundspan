const mockLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../utils/logger", () => ({
    logger: { child: jest.fn(() => mockLog) },
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

const mockGetExpectedTrackCount = jest.fn();
jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        getExpectedTrackCount: (...args: unknown[]) =>
            mockGetExpectedTrackCount(...args),
    },
}));

import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { requestCoalescedLibraryScan } from "../coalescedLibraryScan";
import { classifyDownloadCompleteness } from "../albumDownloadCompleteness";
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
    readDownloadedCount: (result) => result.downloaded,
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
            targetMbid: "rg-target",
            metadata: {
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
        mockGetExpectedTrackCount.mockResolvedValue(3);
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
        mockFindUnique.mockResolvedValue({
            targetMbid: "rg-target",
            metadata: {
                queuedVia: "album-download-queue",
                failedAt: "2026-08-24T10:00:00.000Z",
                partial: true,
            },
        });
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
                expectedTracks: 3,
            }),
        );
        expect(completedUpdate.data.metadata).not.toHaveProperty("failedAt");
        expect(completedUpdate.data.metadata).not.toHaveProperty("partial");
        expect(mockScan).toHaveBeenCalledWith("user-1", "fake-download");
    });

    it("fails a partial download and persists its completeness metadata", async () => {
        mockGetExpectedTrackCount.mockResolvedValueOnce(14);
        download.mockResolvedValueOnce({ downloaded: 1 });

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        const failedUpdate = mockUpdate.mock.calls.find(
            ([call]) => call.data?.error === "Partial download: 1/14 tracks",
        )?.[0];
        expect(failedUpdate.data).toEqual(
            expect.objectContaining({
                status: "failed",
                error: "Partial download: 1/14 tracks",
                completedAt: expect.any(Date),
                metadata: expect.objectContaining({
                    statusText: "Partial download: 1/14 tracks",
                    partial: true,
                    expectedTracks: 14,
                    fakeResult: { downloaded: 1 },
                }),
            }),
        );
        expect(mockLog.warn).toHaveBeenCalledWith(
            "Album download is incomplete",
            {
                jobId: "job-1",
                source: "fake",
                downloadedTracks: 1,
                expectedTracks: 14,
            },
        );
        expect(mockScan).toHaveBeenCalledWith("user-1", "fake-download");
    });

    it("completes when MusicBrainz cannot determine the expected count", async () => {
        const musicBrainzError = new Error("MusicBrainz unavailable");
        mockGetExpectedTrackCount.mockRejectedValueOnce(musicBrainzError);

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
        expect(completedUpdate.data.metadata).not.toHaveProperty(
            "expectedTracks",
        );
        expect(mockLog.warn).toHaveBeenCalledWith(
            "Album completeness verification skipped",
            {
                jobId: "job-1",
                source: "fake",
                albumMbid: "rg-target",
                reason: "MusicBrainz expected-count lookup failed",
                error: musicBrainzError,
            },
        );
    });

    it("treats a zero expected count as unknown and never persists zero", async () => {
        mockGetExpectedTrackCount.mockResolvedValueOnce(0);

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        expect(mockLog.warn).toHaveBeenCalledWith(
            "Album completeness verification skipped",
            {
                jobId: "job-1",
                source: "fake",
                albumMbid: "rg-target",
                reason: "MusicBrainz returned no expected track count",
            },
        );
        expect(JSON.stringify(mockUpdate.mock.calls)).not.toContain(
            '"expectedTracks":0',
        );
    });

    it("uses targetMbid instead of legacy metadata for completeness", async () => {
        mockFindUnique.mockResolvedValueOnce({
            targetMbid: "rg-canonical",
            metadata: { albumMbid: "rg-legacy" },
        });

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { id: "job-1" },
            select: { targetMbid: true, metadata: true },
        });
        expect(mockGetExpectedTrackCount).toHaveBeenCalledWith("rg-canonical");
    });

    it("uses metadata.albumMbid only for legacy jobs without targetMbid", async () => {
        mockFindUnique.mockResolvedValueOnce({
            targetMbid: "",
            metadata: { albumMbid: "rg-legacy" },
        });

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        expect(mockGetExpectedTrackCount).toHaveBeenCalledWith("rg-legacy");
    });

    it("completes when a deluxe provider result exceeds the minimum", async () => {
        mockGetExpectedTrackCount.mockResolvedValueOnce(10);
        download.mockResolvedValueOnce({ downloaded: 16 });

        await runLibraryAlbumDownload(
            processorConfig,
            "job-1",
            "Artist",
            "Album",
            "user-1",
        );

        expect(
            mockUpdate.mock.calls.some(
                ([call]) =>
                    call.data?.status === "completed" &&
                    call.data?.metadata?.expectedTracks === 10,
            ),
        ).toBe(true);
        expect(
            mockUpdate.mock.calls.some(
                ([call]) => call.data?.status === "failed",
            ),
        ).toBe(false);
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

describe("classifyDownloadCompleteness", () => {
    it.each([
        { downloaded: 14, expected: 14, outcome: "complete" },
        { downloaded: 1, expected: 14, outcome: "partial" },
        { downloaded: 0, expected: 14, outcome: "unknown" },
        { downloaded: 1, expected: null, outcome: "unknown" },
        { downloaded: 15, expected: 14, outcome: "complete" },
    ] as const)(
        "classifies $downloaded downloaded against $expected expected as $outcome",
        ({ downloaded, expected, outcome }) => {
            expect(classifyDownloadCompleteness(downloaded, expected)).toBe(
                outcome,
            );
        },
    );
});
