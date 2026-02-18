import { addMonths, endOfWeek, startOfWeek, subDays } from "date-fns";
import { DiscoveryRecommendationsService } from "../discoveryRecommendations";
import { discoverySeeding } from "../discoverySeeding";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";

jest.mock("date-fns", () => {
    const actual = jest.requireActual("date-fns");
    return {
        ...actual,
        addMonths: jest.fn(),
        endOfWeek: jest.fn(),
        startOfWeek: jest.fn(),
        subDays: jest.fn(),
    };
});

jest.mock("../../../utils/db", () => ({
    prisma: {
        userDiscoverConfig: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
        play: {
            findMany: jest.fn(),
        },
        discoverExclusion: {
            findMany: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        discoveryTrack: {
            deleteMany: jest.fn(),
        },
        unavailableAlbum: {
            deleteMany: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock("../discoverySeeding", () => ({
    discoverySeeding: {
        getSeedArtists: jest.fn(),
    },
}));

const NOW = new Date("2025-03-19T12:00:00.000Z");
const WEEK_START = new Date("2025-03-17T00:00:00.000Z");
const WEEK_END = new Date("2025-03-23T23:59:59.999Z");
const SUB_120 = new Date("2024-11-19T12:00:00.000Z");
const SUB_14 = new Date("2025-03-05T12:00:00.000Z");
const EXPIRES_AT = new Date("2025-09-19T12:00:00.000Z");

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockLogger = logger as jest.Mocked<typeof logger>;
const mockDiscoverySeeding = discoverySeeding as jest.Mocked<typeof discoverySeeding>;
const mockAddMonths = addMonths as jest.MockedFunction<typeof addMonths>;
const mockEndOfWeek = endOfWeek as jest.MockedFunction<typeof endOfWeek>;
const mockStartOfWeek = startOfWeek as jest.MockedFunction<typeof startOfWeek>;
const mockSubDays = subDays as jest.MockedFunction<typeof subDays>;

describe("DiscoveryRecommendationsService", () => {
    let service: DiscoveryRecommendationsService;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
        jest.clearAllMocks();

        mockStartOfWeek.mockReturnValue(WEEK_START);
        mockEndOfWeek.mockReturnValue(WEEK_END);
        mockSubDays.mockImplementation((_date: Parameters<typeof subDays>[0], amount: number) =>
            amount === 120 ? SUB_120 : SUB_14
        );
        mockAddMonths.mockReturnValue(EXPIRES_AT);

        jest.spyOn(Math, "random").mockReturnValue(0);

        service = new DiscoveryRecommendationsService();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe("getOrCreateUserConfig", () => {
        it("returns existing user config without creating a new row", async () => {
            const existing = {
                userId: "user-1",
                playlistSize: 12,
                maxRetryAttempts: 3,
                exclusionMonths: 6,
                downloadRatio: 1.3,
                enabled: true,
            };
            (mockPrisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValue(
                existing
            );

            const result = await (service as any).getOrCreateUserConfig("user-1");

            expect(mockPrisma.userDiscoverConfig.findUnique).toHaveBeenCalledWith({
                where: { userId: "user-1" },
            });
            expect(mockPrisma.userDiscoverConfig.create).not.toHaveBeenCalled();
            expect(result).toEqual(existing);
        });

        it("creates default config when user config does not exist", async () => {
            (mockPrisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValue(null);
            (mockPrisma.userDiscoverConfig.create as jest.Mock).mockResolvedValue({
                userId: "user-1",
                enabled: true,
            });

            await (service as any).getOrCreateUserConfig("user-1");

            expect(mockPrisma.userDiscoverConfig.create).toHaveBeenCalledWith({
                data: {
                    userId: "user-1",
                    playlistSize: 10,
                    maxRetryAttempts: 3,
                    exclusionMonths: 6,
                    downloadRatio: 1.3,
                    enabled: true,
                },
            });
        });
    });

    describe("resolveSeedArtistIds", () => {
        it("resolves seed artist IDs from mixed MBID and name inputs", async () => {
            (mockDiscoverySeeding.getSeedArtists as jest.Mock).mockResolvedValue([
                { mbid: "mbid-1", name: "Artist One" },
                { mbid: null, name: "Artist Two" },
                { mbid: "", name: "" },
            ]);
            (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue([
                { id: "artist-1" },
                { id: "artist-2" },
            ]);

            const result = await (service as any).resolveSeedArtistIds("user-1");

            expect(mockDiscoverySeeding.getSeedArtists).toHaveBeenCalledWith("user-1");
            expect(mockPrisma.artist.findMany).toHaveBeenCalledWith({
                where: {
                    OR: [
                        { mbid: { in: ["mbid-1"] } },
                        {
                            name: {
                                equals: "Artist One",
                                mode: "insensitive",
                            },
                        },
                        {
                            name: {
                                equals: "Artist Two",
                                mode: "insensitive",
                            },
                        },
                    ],
                },
                select: { id: true },
                take: 30,
            });
            expect(result).toEqual(["artist-1", "artist-2"]);
        });

        it("returns empty list without querying artists when seeds are empty", async () => {
            (mockDiscoverySeeding.getSeedArtists as jest.Mock).mockResolvedValue([
                { mbid: null, name: null },
                { mbid: "", name: "" },
            ]);

            const result = await (service as any).resolveSeedArtistIds("user-1");

            expect(result).toEqual([]);
            expect(mockPrisma.artist.findMany).not.toHaveBeenCalled();
        });
    });

    describe("buildArtistScoreMap", () => {
        it("prioritizes seeded artists and enriches with similar artist edges", async () => {
            jest
                .spyOn(service as any, "resolveSeedArtistIds")
                .mockResolvedValue(["seed-artist"]);
            (mockPrisma.similarArtist.findMany as jest.Mock).mockResolvedValue([
                { toArtistId: "seed-artist", weight: 0.3 },
                { toArtistId: "related-artist", weight: 0.88 },
                { toArtistId: "fallback-weight", weight: null },
            ]);

            const result = await (service as any).buildArtistScoreMap("user-1");

            expect(mockPrisma.similarArtist.findMany).toHaveBeenCalledWith({
                where: {
                    fromArtistId: { in: ["seed-artist"] },
                },
                orderBy: { weight: "desc" },
                select: {
                    toArtistId: true,
                    weight: true,
                },
                take: 800,
            });
            expect(result.get("seed-artist")).toBe(0.62);
            expect(result.get("related-artist")).toBe(0.88);
            expect(result.get("fallback-weight")).toBe(0.35);
            expect(mockPrisma.play.findMany).not.toHaveBeenCalled();
        });

        it("falls back to recent plays when no seed artists resolve", async () => {
            jest.spyOn(service as any, "resolveSeedArtistIds").mockResolvedValue([]);
            (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
                { track: { album: { artistId: "artist-1" } } },
                { track: { album: { artistId: "artist-1" } } },
                { track: { album: { artistId: "artist-2" } } },
                { track: { album: { artistId: null } } },
                { track: null },
            ]);

            const result = await (service as any).buildArtistScoreMap("user-1");

            expect(mockPrisma.play.findMany).toHaveBeenCalledWith({
                where: {
                    userId: "user-1",
                    playedAt: { gte: SUB_120 },
                },
                select: {
                    track: {
                        select: {
                            album: {
                                select: {
                                    artistId: true,
                                },
                            },
                        },
                    },
                },
                take: 600,
                orderBy: { playedAt: "desc" },
            });
            expect(result.get("artist-1")).toBe(0.5);
            expect(result.get("artist-2")).toBe(0.5);
            expect(result.size).toBe(2);
            expect(mockPrisma.artist.findMany).not.toHaveBeenCalled();
        });

        it("uses artist catalog fallback when seeds and plays produce no scores", async () => {
            jest.spyOn(service as any, "resolveSeedArtistIds").mockResolvedValue([]);
            (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue([
                { id: "fallback-1" },
                { id: "fallback-2" },
            ]);

            const result = await (service as any).buildArtistScoreMap("user-1");

            expect(mockPrisma.artist.findMany).toHaveBeenCalledWith({
                where: {
                    albums: {
                        some: {
                            tracks: {
                                some: {},
                            },
                        },
                    },
                },
                select: { id: true },
                take: 100,
                orderBy: { countsLastUpdated: "desc" },
            });
            expect(result.get("fallback-1")).toBe(0.4);
            expect(result.get("fallback-2")).toBe(0.4);
        });
    });

    describe("selectTracks", () => {
        it("filters recent plays/exclusions, de-duplicates albums, and assigns tiers", async () => {
            jest
                .spyOn(service as any, "buildArtistScoreMap")
                .mockResolvedValue(new Map([["artist-priority", 0.72]]));
            (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
                { trackId: "recent-track" },
            ]);
            (mockPrisma.discoverExclusion.findMany as jest.Mock).mockResolvedValue([
                { albumMbid: "excluded-rg" },
            ]);

            const candidateTracks = [
                {
                    id: "track-priority",
                    title: "Priority Track",
                    duration: 241,
                    filePath: "/music/priority.flac",
                    albumId: "album-1",
                    album: {
                        title: "Album One",
                        rgMbid: "rg-1",
                        coverUrl: "cover-1",
                        artistId: "artist-priority",
                        artist: {
                            id: "artist-priority",
                            name: "Priority Artist",
                            mbid: "artist-mbid-1",
                        },
                    },
                },
                {
                    id: "track-same-album",
                    title: "Duplicate Album Track",
                    duration: 200,
                    filePath: "/music/duplicate.flac",
                    albumId: "album-1",
                    album: {
                        title: "Album One",
                        rgMbid: "rg-1",
                        coverUrl: "cover-1",
                        artistId: "artist-priority",
                        artist: {
                            id: "artist-priority",
                            name: "Priority Artist",
                            mbid: "artist-mbid-1",
                        },
                    },
                },
            ];

            const fallbackTracks = [
                {
                    id: "track-fallback",
                    title: "Fallback Track",
                    duration: 180,
                    filePath: "/music/fallback.flac",
                    albumId: "album-2",
                    album: {
                        title: "Album Two",
                        rgMbid: "rg-2",
                        coverUrl: null,
                        artist: {
                            id: "artist-fallback",
                            name: "Fallback Artist",
                            mbid: "artist-mbid-2",
                        },
                    },
                },
            ];

            (mockPrisma.track.findMany as jest.Mock)
                .mockResolvedValueOnce(candidateTracks)
                .mockResolvedValueOnce(fallbackTracks);

            const result = await (service as any).selectTracks("user-1", 2);

            expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(2);
            expect((mockPrisma.track.findMany as jest.Mock).mock.calls[0][0]).toEqual({
                where: {
                    duration: { gt: 0 },
                    id: { notIn: ["recent-track"] },
                    album: {
                        location: "LIBRARY",
                        artistId: { in: ["artist-priority"] },
                        rgMbid: { notIn: ["excluded-rg"] },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                    mbid: true,
                                },
                            },
                        },
                    },
                },
                take: 220,
                orderBy: [{ updatedAt: "desc" }],
            });
            expect((mockPrisma.track.findMany as jest.Mock).mock.calls[1][0]).toEqual({
                where: {
                    duration: { gt: 0 },
                    id: { notIn: ["track-priority"] },
                    album: {
                        location: "LIBRARY",
                        rgMbid: { notIn: ["excluded-rg"] },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                    mbid: true,
                                },
                            },
                        },
                    },
                },
                take: 180,
                orderBy: [{ updatedAt: "desc" }],
            });

            expect(result).toEqual([
                {
                    trackId: "track-priority",
                    title: "Priority Track",
                    duration: 241,
                    filePath: "/music/priority.flac",
                    albumId: "album-1",
                    albumTitle: "Album One",
                    albumMbid: "rg-1",
                    artistId: "artist-priority",
                    artistName: "Priority Artist",
                    artistMbid: "artist-mbid-1",
                    coverUrl: "cover-1",
                    similarity: 0.72,
                    tier: "high",
                },
                {
                    trackId: "track-fallback",
                    title: "Fallback Track",
                    duration: 180,
                    filePath: "/music/fallback.flac",
                    albumId: "album-2",
                    albumTitle: "Album Two",
                    albumMbid: "rg-2",
                    artistId: "artist-fallback",
                    artistName: "Fallback Artist",
                    artistMbid: "artist-mbid-2",
                    coverUrl: null,
                    similarity: 0.34,
                    tier: "explore",
                },
            ]);
        });

        it("assigns wildcard tier when similarity clamps below explore threshold", async () => {
            jest
                .spyOn(service as any, "buildArtistScoreMap")
                .mockResolvedValue(new Map([["artist-low", -1]]));
            (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.discoverExclusion.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue([
                {
                    id: "track-low",
                    title: "Low Similarity",
                    duration: 150,
                    filePath: "/music/low.flac",
                    albumId: "album-low",
                    album: {
                        title: "Low Album",
                        rgMbid: "rg-low",
                        coverUrl: null,
                        artistId: "artist-low",
                        artist: {
                            id: "artist-low",
                            name: "Low Artist",
                            mbid: "artist-mbid-low",
                        },
                    },
                },
            ]);

            const result = await (service as any).selectTracks("user-1", 1);

            expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(1);
            expect(result).toEqual([
                expect.objectContaining({
                    trackId: "track-low",
                    similarity: 0.15,
                    tier: "wildcard",
                }),
            ]);
        });
    });

    describe("generatePlaylist (generateForUser equivalent)", () => {
        it("creates a fresh weekly playlist, writes tracks, and upserts exclusions", async () => {
            const selectedTracks = [
                {
                    trackId: "track-1",
                    title: "Track One",
                    duration: 210,
                    filePath: "/music/track-1.flac",
                    albumId: "album-1",
                    albumTitle: "Album One",
                    albumMbid: "rg-1",
                    artistId: "artist-1",
                    artistName: "Artist One",
                    artistMbid: "artist-mbid-1",
                    coverUrl: "cover-1",
                    similarity: 0.72,
                    tier: "high",
                },
                {
                    trackId: "track-2",
                    title: "Track Two",
                    duration: 185,
                    filePath: "/music/track-2.flac",
                    albumId: "album-2",
                    albumTitle: "Album Two",
                    albumMbid: "rg-2",
                    artistId: "artist-2",
                    artistName: "Artist Two",
                    artistMbid: "artist-mbid-2",
                    coverUrl: null,
                    similarity: 0.51,
                    tier: "medium",
                },
            ];

            jest
                .spyOn(service as any, "getOrCreateUserConfig")
                .mockResolvedValue({
                    userId: "user-1",
                    playlistSize: 4,
                    enabled: true,
                    exclusionMonths: 6,
                });
            const selectTracksSpy = jest
                .spyOn(service as any, "selectTracks")
                .mockResolvedValue(selectedTracks);

            const tx = {
                discoveryAlbum: {
                    findMany: jest.fn().mockResolvedValue([{ id: "old-album" }]),
                    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
                    create: jest
                        .fn()
                        .mockResolvedValueOnce({ id: "new-album-1" })
                        .mockResolvedValueOnce({ id: "new-album-2" }),
                },
                discoveryTrack: {
                    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
                    create: jest.fn().mockResolvedValue({}),
                },
                unavailableAlbum: {
                    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                discoverExclusion: {
                    upsert: jest.fn().mockResolvedValue({}),
                },
                userDiscoverConfig: {
                    update: jest.fn().mockResolvedValue({}),
                },
            };

            (mockPrisma.$transaction as jest.Mock).mockImplementation(
                async (callback: (transactionClient: typeof tx) => Promise<unknown>) =>
                    callback(tx)
            );

            const result = await service.generatePlaylist("user-1");

            expect(selectTracksSpy).toHaveBeenCalledWith("user-1", 5);
            expect(tx.discoveryAlbum.findMany).toHaveBeenCalledWith({
                where: {
                    userId: "user-1",
                    weekStartDate: WEEK_START,
                },
                select: { id: true },
            });
            expect(tx.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: {
                    discoveryAlbumId: { in: ["old-album"] },
                },
            });
            expect(tx.discoveryAlbum.deleteMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["old-album"] },
                },
            });
            expect(tx.unavailableAlbum.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: "user-1",
                    weekStartDate: WEEK_START,
                },
            });

            expect(tx.discoveryAlbum.create).toHaveBeenCalledTimes(2);
            expect(tx.discoveryAlbum.create).toHaveBeenNthCalledWith(1, {
                data: {
                    userId: "user-1",
                    rgMbid: "rg-1",
                    artistName: "Artist One",
                    artistMbid: "artist-mbid-1",
                    albumTitle: "Album One",
                    weekStartDate: WEEK_START,
                    weekEndDate: WEEK_END,
                    status: "ACTIVE",
                    downloadedAt: NOW,
                    folderPath: "",
                    similarity: 0.72,
                    tier: "high",
                },
            });

            expect(tx.discoveryTrack.create).toHaveBeenCalledWith({
                data: {
                    discoveryAlbumId: "new-album-1",
                    trackId: "track-1",
                    fileName: "Track One",
                    filePath: "/music/track-1.flac",
                    inPlaylistCount: 1,
                    userKept: false,
                },
            });
            expect(tx.discoverExclusion.upsert).toHaveBeenCalledTimes(2);
            expect(tx.discoverExclusion.upsert).toHaveBeenCalledWith({
                where: {
                    userId_albumMbid: {
                        userId: "user-1",
                        albumMbid: "rg-1",
                    },
                },
                create: {
                    userId: "user-1",
                    albumMbid: "rg-1",
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    lastSuggestedAt: NOW,
                    expiresAt: EXPIRES_AT,
                },
                update: {
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    lastSuggestedAt: NOW,
                    expiresAt: EXPIRES_AT,
                },
            });
            expect(tx.userDiscoverConfig.update).toHaveBeenCalledWith({
                where: { userId: "user-1" },
                data: { lastGeneratedAt: NOW },
            });

            expect(mockLogger.info).toHaveBeenCalledWith(
                "[DiscoveryRecommendations] Generated 2 recommendation tracks for user user-1"
            );
            expect(result).toEqual({
                success: true,
                playlistName: `Discover Weekly (Week of ${WEEK_START.toLocaleDateString()})`,
                songCount: 2,
            });
        });

        it("throws when discovery recommendations are disabled", async () => {
            jest
                .spyOn(service as any, "getOrCreateUserConfig")
                .mockResolvedValue({ enabled: false, playlistSize: 10 });

            await expect(service.generatePlaylist("user-1")).rejects.toThrow(
                "Discovery Weekly not enabled"
            );
            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });

        it("surfaces transaction failures and skips success logging", async () => {
            jest
                .spyOn(service as any, "getOrCreateUserConfig")
                .mockResolvedValue({
                    enabled: true,
                    playlistSize: 10,
                    exclusionMonths: 0,
                });
            jest.spyOn(service as any, "selectTracks").mockResolvedValue([]);
            (mockPrisma.$transaction as jest.Mock).mockRejectedValue(
                new Error("transaction failed")
            );

            await expect(service.generatePlaylist("user-1")).rejects.toThrow(
                "transaction failed"
            );
            expect(mockLogger.info).not.toHaveBeenCalled();
        });
    });

    describe("getCurrentPlaylist", () => {
        it("returns playlist shape and derives default tier from similarity when missing", async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
                {
                    id: "discovery-1",
                    rgMbid: "rg-1",
                    similarity: null,
                    tier: null,
                    tracks: [
                        { trackId: "track-1" },
                        { trackId: null },
                    ],
                },
                {
                    id: "discovery-2",
                    rgMbid: "rg-2",
                    similarity: 0.82,
                    tier: "medium",
                    tracks: [
                        { trackId: "track-2" },
                        { trackId: "missing-track" },
                    ],
                },
            ]);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue([
                {
                    id: "track-1",
                    title: "Track One",
                    duration: 203,
                    album: {
                        title: "Album One",
                        coverUrl: "cover-1",
                        artist: {
                            name: "Artist One",
                        },
                    },
                },
                {
                    id: "track-2",
                    title: "Track Two",
                    duration: 177,
                    album: {
                        title: "Album Two",
                        coverUrl: null,
                        artist: {
                            name: "Artist Two",
                        },
                    },
                },
            ]);

            const result = await service.getCurrentPlaylist("user-1");

            expect(mockPrisma.discoveryAlbum.findMany).toHaveBeenCalledWith({
                where: {
                    userId: "user-1",
                    weekStartDate: WEEK_START,
                    status: { in: ["ACTIVE", "LIKED"] },
                },
                include: {
                    tracks: true,
                },
                orderBy: { downloadedAt: "asc" },
            });
            expect(mockPrisma.track.findMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["track-1", "track-2", "missing-track"] },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
            });
            expect(result).toEqual({
                weekStart: WEEK_START,
                weekEnd: WEEK_END,
                tracks: [
                    {
                        id: "track-1",
                        title: "Track One",
                        artist: "Artist One",
                        album: "Album One",
                        albumId: "rg-1",
                        isLiked: false,
                        likedAt: null,
                        similarity: 0.35,
                        tier: "explore",
                        coverUrl: "cover-1",
                        available: true,
                        duration: 203,
                        sourceType: "local",
                    },
                    {
                        id: "track-2",
                        title: "Track Two",
                        artist: "Artist Two",
                        album: "Album Two",
                        albumId: "rg-2",
                        isLiked: false,
                        likedAt: null,
                        similarity: 0.82,
                        tier: "medium",
                        coverUrl: null,
                        available: true,
                        duration: 177,
                        sourceType: "local",
                    },
                ],
                unavailable: [],
                totalCount: 2,
                unavailableCount: 0,
            });
        });

        it("returns empty track list without querying library tracks when no IDs exist", async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
                {
                    id: "discovery-1",
                    rgMbid: "rg-1",
                    similarity: 0.45,
                    tier: "explore",
                    tracks: [{ trackId: null }],
                },
            ]);

            const result = await service.getCurrentPlaylist("user-1");

            expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
            expect(result.tracks).toEqual([]);
            expect(result.totalCount).toBe(0);
        });
    });

    describe("clearCurrentPlaylist (clearForUser equivalent)", () => {
        it("removes weekly discovery tracks/albums and clears unavailable entries", async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
                { id: "album-1" },
                { id: "album-2" },
            ]);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({
                count: 2,
            });
            (mockPrisma.discoveryAlbum.deleteMany as jest.Mock).mockResolvedValue({
                count: 2,
            });
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({
                count: 1,
            });

            const result = await service.clearCurrentPlaylist("user-1");

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: {
                    discoveryAlbumId: { in: ["album-1", "album-2"] },
                },
            });
            expect(mockPrisma.discoveryAlbum.deleteMany).toHaveBeenCalledWith({
                where: {
                    id: { in: ["album-1", "album-2"] },
                },
            });
            expect(mockPrisma.unavailableAlbum.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: "user-1",
                    weekStartDate: WEEK_START,
                },
            });
            expect(result).toEqual({ clearedCount: 2 });
        });

        it("still clears unavailable albums when nothing is in the current playlist", async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({
                count: 0,
            });

            const result = await service.clearCurrentPlaylist("user-1");

            expect(mockPrisma.discoveryTrack.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryAlbum.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.unavailableAlbum.deleteMany).toHaveBeenCalledWith({
                where: {
                    userId: "user-1",
                    weekStartDate: WEEK_START,
                },
            });
            expect(result).toEqual({ clearedCount: 0 });
        });
    });
});
