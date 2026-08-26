import {
    decideAlbumRetry,
    selectNextAlbum,
    tryNextAlbumFromArtist,
} from "../albumRetryStrategy";
import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { getSystemSettings } from "../../../utils/systemSettings";
import { spotifyImportService } from "../../spotifyImport";

jest.mock("../../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));
jest.mock("../../../utils/db", () => ({
    prisma: {
        downloadJob: {
            findMany: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
        },
    },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));
jest.mock("../../lidarr", () => ({
    lidarrService: { getArtistAlbums: jest.fn() },
}));
jest.mock("../../spotifyImport", () => ({
    spotifyImportService: { checkImportCompletion: jest.fn() },
}));

describe("albumRetryStrategy decisions", () => {
    beforeEach(() => jest.clearAllMocks());

    test.each([
        [
            "discovery jobs",
            { discoveryBatchId: "batch-1", metadata: { artistMbid: "a-1" } },
            "discovery",
        ],
        [
            "Spotify imports",
            { metadata: { artistMbid: "a-1", spotifyImportJobId: "import-1" } },
            "exact-match",
        ],
        [
            "explicit no-fallback jobs",
            { metadata: { artistMbid: "a-1", noFallback: true } },
            "exact-match",
        ],
        ["jobs without an artist MBID", { metadata: {} }, "missing-artist"],
    ])("exhausts %s", (_label, job, reason) => {
        expect(decideAlbumRetry(job as never)).toEqual({
            kind: "exhaust",
            reason,
        });
    });

    it("searches the resolved artist for ordinary library jobs", () => {
        expect(
            decideAlbumRetry({
                artistMbid: "artist-column",
                metadata: {
                    artistMbid: "artist-metadata",
                    artistName: "The Artist",
                },
            } as never),
        ).toEqual({
            kind: "search",
            artistMbid: "artist-column",
            artistName: "The Artist",
        });
    });

    it("prefers an untried studio album and falls back to the first untried release", () => {
        const releases = [
            { foreignAlbumId: "tried", title: "Tried", albumType: "Album" },
            { foreignAlbumId: "single", title: "Single", albumType: "Single" },
            { foreignAlbumId: "studio", title: "Studio", albumType: "Album" },
        ];

        expect(selectNextAlbum(releases as never, new Set(["tried"]))).toBe(
            releases[2],
        );
        expect(
            selectNextAlbum(releases.slice(0, 2) as never, new Set(["tried"])),
        ).toBe(releases[1]);
        expect(
            selectNextAlbum(
                releases as never,
                new Set(["tried", "single", "studio"]),
            ),
        ).toBeUndefined();
    });

    it("creates and starts the selected same-artist fallback", async () => {
        const mockPrisma = prisma as any;
        const mockLidarr = lidarrService as any;
        mockLidarr.getArtistAlbums.mockResolvedValue([
            {
                id: 2,
                foreignAlbumId: "next-album",
                title: "Next Album",
                albumType: "Album",
            },
        ]);
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.downloadJob.update.mockResolvedValue({});
        mockPrisma.downloadJob.create.mockResolvedValue({ id: "fallback-job" });
        (getSystemSettings as jest.Mock).mockResolvedValue({
            musicPath: "/configured-music",
        });
        const startDownload = jest.fn().mockResolvedValue({ success: true });
        const markJobExhausted = jest.fn();

        const result = await tryNextAlbumFromArtist(
            {
                id: "original-job",
                userId: "user-1",
                subject: "Artist - Original",
                targetMbid: "original-album",
                artistMbid: "artist-1",
                discoveryBatchId: null,
                metadata: { artistName: "Artist" },
            } as never,
            "original exhausted",
            { startDownload, markJobExhausted },
        );

        expect(result).toEqual({
            retried: true,
            failed: false,
            jobId: "fallback-job",
        });
        expect(startDownload).toHaveBeenCalledWith(
            "fallback-job",
            "Artist",
            "Next Album",
            "next-album",
            "user-1",
        );
        expect(markJobExhausted).not.toHaveBeenCalled();
    });

    it("persists exhaustion before reading settings and remains exhausted when settings fail", async () => {
        const mockPrisma = prisma as any;
        const callOrder: string[] = [];
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValue([
            {
                id: 2,
                foreignAlbumId: "next-album",
                title: "Next Album",
                albumType: "Album",
            },
        ]);
        mockPrisma.downloadJob.findMany.mockResolvedValue([]);
        mockPrisma.downloadJob.update.mockImplementation(async () => {
            callOrder.push("exhausted");
            return {};
        });
        (getSystemSettings as jest.Mock).mockImplementation(async () => {
            callOrder.push("settings");
            throw new Error("settings unavailable");
        });
        const markJobExhausted = jest.fn().mockResolvedValue({
            retried: false,
            failed: true,
            jobId: "original-job",
        });

        await expect(
            tryNextAlbumFromArtist(
                {
                    id: "original-job",
                    userId: "user-1",
                    subject: "Artist - Original",
                    targetMbid: "original-album",
                    artistMbid: "artist-1",
                    discoveryBatchId: null,
                    metadata: { artistName: "Artist" },
                } as never,
                "original exhausted",
                { startDownload: jest.fn(), markJobExhausted },
            ),
        ).resolves.toEqual({
            retried: false,
            failed: true,
            jobId: "original-job",
        });
        expect(callOrder).toEqual(["exhausted", "settings"]);
        expect(mockPrisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "original-job" },
            data: expect.objectContaining({ status: "exhausted" }),
        });
    });

    it("checks Spotify import completion after exact-match exhaustion", async () => {
        const markJobExhausted = jest.fn().mockResolvedValue({
            retried: false,
            failed: true,
            jobId: "spotify-job",
        });
        (
            spotifyImportService.checkImportCompletion as jest.Mock
        ).mockResolvedValue(undefined);

        await tryNextAlbumFromArtist(
            makeRetryJob({ spotifyImportJobId: "spotify-import-1" }),
            "exact album unavailable",
            { startDownload: jest.fn(), markJobExhausted },
        );

        expect(spotifyImportService.checkImportCompletion).toHaveBeenCalledWith(
            "spotify-import-1",
        );
    });

    it("exhausts the original job after artist album lookup failure", async () => {
        (lidarrService.getArtistAlbums as jest.Mock).mockRejectedValue(
            new Error("lookup failed"),
        );
        const markJobExhausted = exhaustedResult();

        await tryNextAlbumFromArtist(makeRetryJob(), "lookup failed", {
            startDownload: jest.fn(),
            markJobExhausted,
        });

        expect(markJobExhausted).toHaveBeenCalledWith(
            expect.objectContaining({ id: "original-job" }),
            "lookup failed",
        );
    });

    it("exhausts the original job when Lidarr returns no albums", async () => {
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValue([]);
        const markJobExhausted = exhaustedResult();

        await tryNextAlbumFromArtist(makeRetryJob(), "no albums", {
            startDownload: jest.fn(),
            markJobExhausted,
        });

        expect(markJobExhausted).toHaveBeenCalledTimes(1);
    });

    it("exhausts the original job when every artist album was tried", async () => {
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValue([
            {
                id: 1,
                foreignAlbumId: "original-album",
                title: "Original",
                albumType: "Album",
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);
        const markJobExhausted = exhaustedResult();

        await tryNextAlbumFromArtist(makeRetryJob(), "all tried", {
            startDownload: jest.fn(),
            markJobExhausted,
        });

        expect(markJobExhausted).toHaveBeenCalledTimes(1);
    });

    it("returns failure when the fallback download cannot start", async () => {
        prepareFallbackPersistence();
        const startDownload = jest.fn().mockResolvedValue({ success: false });

        await expect(
            tryNextAlbumFromArtist(makeRetryJob(), "retry", {
                startDownload,
                markJobExhausted: exhaustedResult(),
            }),
        ).resolves.toEqual({
            retried: false,
            failed: true,
            jobId: "fallback-job",
        });
    });

    it("persists the original job as exhausted before fallback creation", async () => {
        prepareFallbackPersistence();

        await tryNextAlbumFromArtist(makeRetryJob(), "retry", {
            startDownload: jest.fn().mockResolvedValue({ success: true }),
            markJobExhausted: exhaustedResult(),
        });

        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "original-job" },
            data: {
                status: "exhausted",
                error: "All releases exhausted - trying: Next Album",
                completedAt: expect.any(Date),
            },
        });
    });

    it("persists the fallback job with the historical metadata payload", async () => {
        prepareFallbackPersistence();

        await tryNextAlbumFromArtist(
            makeRetryJob({ downloadType: "manual", rootFolderPath: "/custom" }),
            "retry",
            {
                startDownload: jest.fn().mockResolvedValue({ success: true }),
                markJobExhausted: exhaustedResult(),
            },
        );

        expect(prisma.downloadJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "user-1",
                subject: "Artist - Next Album",
                type: "album",
                targetMbid: "next-album",
                status: "pending",
                discoveryBatchId: null,
                artistMbid: "artist-1",
                metadata: {
                    artistName: "Artist",
                    artistMbid: "artist-1",
                    albumTitle: "Next Album",
                    albumMbid: "next-album",
                    lidarrAlbumId: 2,
                    sameArtistFallback: true,
                    originalJobId: "original-job",
                    downloadType: "manual",
                    rootFolderPath: "/custom",
                },
            }),
        });
    });

    function makeRetryJob(metadata: Record<string, unknown> = {}) {
        return {
            id: "original-job",
            userId: "user-1",
            subject: "Artist - Original",
            targetMbid: "original-album",
            artistMbid: "artist-1",
            discoveryBatchId: null,
            metadata: { artistName: "Artist", ...metadata },
        } as never;
    }

    function exhaustedResult() {
        return jest.fn().mockResolvedValue({
            retried: false,
            failed: true,
            jobId: "original-job",
        });
    }

    function prepareFallbackPersistence(): void {
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValue([
            {
                id: 2,
                foreignAlbumId: "next-album",
                title: "Next Album",
                albumType: "Album",
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
        (prisma.downloadJob.create as jest.Mock).mockResolvedValue({
            id: "fallback-job",
        });
        (getSystemSettings as jest.Mock).mockResolvedValue({
            musicPath: "/configured-music",
        });
    }
});
