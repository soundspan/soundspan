import { ProgrammaticPlaylistService } from "../programmaticPlaylists";
import { prisma } from "../../utils/db";
import { lastFmService } from "../lastfm";

jest.mock("../../utils/db", () => ({
    prisma: {
        play: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
        },
        trackGenre: {
            findMany: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
        artist: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        album: {
            count: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../lastfm", () => ({
    lastFmService: {
        getSimilarArtists: jest.fn(),
    },
}));

jest.mock("../moodBucketService", () => ({
    moodBucketService: {
        getUserMoodMix: jest.fn(),
        getMoodMix: jest.fn(),
    },
}));

type MockTrack = {
    id: string;
    album: {
        coverUrl: string | null;
        artist: {
            id: string;
        };
    };
};

function makeTracks(
    count: number,
    prefix: string,
    options: { artistGroups?: number } = {}
): MockTrack[] {
    const artistGroups = Math.max(1, options.artistGroups ?? count);
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-track-${index + 1}`,
        album: {
            coverUrl: `${prefix}-cover-${index + 1}.jpg`,
            artist: {
                id: `${prefix}-artist-${index % artistGroups}`,
            },
        },
    }));
}

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockLastFmService = lastFmService as jest.Mocked<typeof lastFmService>;

function countMaxPerArtist(trackIds: string[], tracksById: Map<string, MockTrack>): number {
    const counts = new Map<string, number>();
    for (const trackId of trackIds) {
        const track = tracksById.get(trackId);
        if (!track) continue;
        const artistId = track.album.artist.id;
        counts.set(artistId, (counts.get(artistId) ?? 0) + 1);
    }
    return Math.max(...Array.from(counts.values()));
}

function countUniqueArtists(trackIds: string[], tracksById: Map<string, MockTrack>): number {
    const unique = new Set<string>();
    for (const trackId of trackIds) {
        const track = tracksById.get(trackId);
        if (!track) continue;
        unique.add(track.album.artist.id);
    }
    return unique.size;
}

describe("ProgrammaticPlaylistService priority diversity generators", () => {
    let service: ProgrammaticPlaylistService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new ProgrammaticPlaylistService();
    });

    it("generateTopTracksMix enforces artist cap while keeping target size", async () => {
        const playStats = Array.from({ length: 30 }, (_, i) => ({
            trackId: `track-${i + 1}`,
            _count: { trackId: 30 - i },
        }));

        const tracks: MockTrack[] = playStats.map((entry, index) => ({
            id: entry.trackId,
            album: {
                coverUrl: `cover-${entry.trackId}.jpg`,
                artist: {
                    id: index < 10 ? "artist-dominant" : `artist-${index}`,
                },
            },
        }));

        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(playStats);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

        const mix = await service.generateTopTracksMix("user-1");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(tracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
    });

    it("generateTopTracksMix preserves ranked order for surviving strict-cap selections", async () => {
        const playStats = Array.from({ length: 20 }, (_, i) => ({
            trackId: `rank-track-${i + 1}`,
            _count: { trackId: 100 - i },
        }));

        const tracks: MockTrack[] = playStats.map((entry, index) => ({
            id: entry.trackId,
            album: {
                coverUrl: `cover-${entry.trackId}.jpg`,
                artist: {
                    id: `artist-${index + 1}`,
                },
            },
        }));

        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(playStats);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

        const mix = await service.generateTopTracksMix("user-1");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);
        expect(mix!.trackIds.slice(0, 5)).toEqual([
            "rank-track-1",
            "rank-track-2",
            "rank-track-3",
            "rank-track-4",
            "rank-track-5",
        ]);
    });

    it("generateTopTracksMix backfills from library when strict ranked cap underfills", async () => {
        const playStats = Array.from({ length: 24 }, (_, i) => ({
            trackId: `ranked-track-${i + 1}`,
            _count: { trackId: 200 - i },
        }));

        const rankedTracks: MockTrack[] = playStats.map((entry, index) => ({
            id: entry.trackId,
            album: {
                coverUrl: `cover-${entry.trackId}.jpg`,
                artist: {
                    id: `ranked-artist-${index % 3}`,
                },
            },
        }));

        const fallbackLibraryTracks: MockTrack[] = Array.from({ length: 80 }, (_, i) => ({
            id: `fallback-track-${i + 1}`,
            album: {
                coverUrl: `fallback-cover-${i + 1}.jpg`,
                artist: {
                    id: `fallback-artist-${Math.floor(i / 2)}`,
                },
            },
        }));

        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(playStats);
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(rankedTracks)
            .mockResolvedValueOnce(fallbackLibraryTracks);

        const mix = await service.generateTopTracksMix("user-1");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(
            [...rankedTracks, ...fallbackLibraryTracks].map((track) => [track.id, track])
        );
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
        expect(mix!.trackIds.some((trackId) => trackId.startsWith("fallback-track-"))).toBe(
            true
        );
    });

    it("generateGenreMix expands candidate pool and preserves strict diversity", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([
            {
                id: "genre-1",
                name: "electronic",
                _count: { trackGenres: 24 },
            },
        ]);

        const baseGenreTracks: MockTrack[] = Array.from({ length: 8 }, (_, i) => ({
            id: `genre-base-${i + 1}`,
            album: {
                coverUrl: `genre-base-cover-${i + 1}.jpg`,
                artist: {
                    id: i < 6 ? "genre-dominant" : `genre-base-artist-${i}`,
                },
            },
        }));
        (mockPrisma.trackGenre.findMany as jest.Mock).mockResolvedValue(
            baseGenreTracks.map((track) => ({ track }))
        );

        const fallbackGenreTracks: MockTrack[] = Array.from({ length: 24 }, (_, i) => ({
            id: `genre-fallback-${i + 1}`,
            album: {
                coverUrl: `genre-fallback-cover-${i + 1}.jpg`,
                artist: {
                    id: `genre-fallback-artist-${i + 1}`,
                },
            },
        }));
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(fallbackGenreTracks);

        const mix = await service.generateGenreMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);
        expect(mix!.trackIds.some((trackId) => trackId.startsWith("genre-fallback-"))).toBe(
            true
        );

        const tracksById = new Map(
            [...baseGenreTracks, ...fallbackGenreTracks].map((track) => [track.id, track])
        );
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
        expect(countUniqueArtists(mix!.trackIds, tracksById)).toBeGreaterThanOrEqual(11);
    });

    it("generateEraMix rotates by decade and enforces diversity", async () => {
        (mockPrisma.album.findMany as jest.Mock).mockResolvedValue([
            { year: 1991, originalYear: null, displayYear: null },
            { year: 2004, originalYear: null, displayYear: null },
            { year: 2012, originalYear: null, displayYear: null },
        ]);

        const eraTracks: MockTrack[] = Array.from({ length: 28 }, (_, i) => ({
            id: `era-track-${i + 1}`,
            album: {
                coverUrl: `era-cover-${i + 1}.jpg`,
                artist: {
                    id: i < 8 ? "era-dominant" : `era-artist-${Math.floor(i / 2)}`,
                },
            },
        }));
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(eraTracks);

        const mix = await service.generateEraMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);
        expect(mix!.name).toMatch(/Your \d{4}s Mix/);

        const tracksById = new Map(eraTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
    });

    it("generateRediscoverMix keeps target size with capped artist concentration", async () => {
        const rediscoverTracks = Array.from({ length: 40 }, (_, i) => ({
            id: `rediscover-track-${i + 1}`,
            _count: { plays: i < 30 ? 0 : 1 },
            album: {
                coverUrl: `rediscover-cover-${i + 1}.jpg`,
                artist: {
                    id: i < 12 ? "rediscover-dominant" : `rediscover-artist-${Math.floor(i / 2)}`,
                },
            },
        }));

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(rediscoverTracks);

        const mix = await service.generateRediscoverMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(
            rediscoverTracks.map((track) => [track.id, track as unknown as MockTrack])
        );
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
    });

    it("generatePartyMix applies artist diversity and returns target size", async () => {
        const partyTracks: MockTrack[] = Array.from({ length: 30 }, (_, i) => ({
            id: `party-track-${i + 1}`,
            album: {
                coverUrl: `party-cover-${i + 1}.jpg`,
                artist: {
                    id: i < 8 ? "party-dominant" : `party-artist-${Math.floor(i / 2)}`,
                },
            },
        }));

        const genres = [
            {
                trackGenres: partyTracks.map((track) => ({ track })),
            },
        ];

        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue(genres);

        const mix = await service.generatePartyMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(partyTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
    });

    it("generatePartyMix fallback preserves canonical and user-genre matching in paged scan", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([]);

        const firstPageNonMatches = Array.from({ length: 100 }, (_, i) => ({
            id: `scan-a-${String(i + 1).padStart(3, "0")}`,
            album: {
                coverUrl: `scan-a-cover-${i + 1}.jpg`,
                genres: ["baroque"],
                userGenres: null,
                artist: {
                    id: `scan-a-artist-${i + 1}`,
                    userGenres: null,
                },
            },
        }));

        const canonicalMatches = Array.from({ length: 6 }, (_, i) => ({
            id: `match-canonical-${i + 1}`,
            album: {
                coverUrl: `match-canonical-cover-${i + 1}.jpg`,
                genres: ["dance pop"],
                userGenres: null,
                artist: {
                    id: `match-canonical-artist-${i + 1}`,
                    userGenres: null,
                },
            },
        }));
        const albumUserMatches = Array.from({ length: 5 }, (_, i) => ({
            id: `match-album-user-${i + 1}`,
            album: {
                coverUrl: `match-album-user-cover-${i + 1}.jpg`,
                genres: null,
                userGenres: ["club edits"],
                artist: {
                    id: `match-album-user-artist-${i + 1}`,
                    userGenres: null,
                },
            },
        }));
        const artistUserMatches = Array.from({ length: 5 }, (_, i) => ({
            id: `match-artist-user-${i + 1}`,
            album: {
                coverUrl: `match-artist-user-cover-${i + 1}.jpg`,
                genres: null,
                userGenres: null,
                artist: {
                    id: `match-artist-user-artist-${i + 1}`,
                    userGenres: ["edm"],
                },
            },
        }));

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // Tag strategy
            .mockResolvedValueOnce(firstPageNonMatches) // Paged scan page 1
            .mockResolvedValueOnce([
                ...canonicalMatches,
                ...albumUserMatches,
                ...artistUserMatches,
            ]); // Paged scan page 2

        const mix = await service.generatePartyMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds.length).toBeGreaterThanOrEqual(15);
        expect(mix!.trackIds).toEqual(
            expect.arrayContaining([
                "match-canonical-1",
                "match-album-user-1",
                "match-artist-user-1",
            ])
        );
    });

    it("generateChillMix respects daily target size with diversity applied", async () => {
        const chillTracks: MockTrack[] = Array.from({ length: 12 }, (_, i) => ({
            id: `chill-track-${i + 1}`,
            album: {
                coverUrl: `chill-cover-${i + 1}.jpg`,
                artist: {
                    id: `chill-artist-${Math.floor(i / 2)}`,
                },
            },
        }));

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(chillTracks);

        const mix = await service.generateChillMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(10);

        const tracksById = new Map(chillTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
        expect(countUniqueArtists(mix!.trackIds, tracksById)).toBeGreaterThanOrEqual(6);
    });

    it("generateWorkoutMix uses enhanced pool and keeps artist cap", async () => {
        const workoutTracks: MockTrack[] = Array.from({ length: 34 }, (_, i) => ({
            id: `workout-track-${i + 1}`,
            album: {
                coverUrl: `workout-cover-${i + 1}.jpg`,
                artist: {
                    id: i < 10 ? "workout-dominant" : `workout-artist-${Math.floor(i / 2)}`,
                },
            },
        }));

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(workoutTracks);

        const mix = await service.generateWorkoutMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(workoutTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
    });

    it("generateFocusMix applies unique-first diversity path", async () => {
        const focusTracks: MockTrack[] = Array.from({ length: 30 }, (_, i) => ({
            id: `focus-track-${i + 1}`,
            album: {
                coverUrl: `focus-cover-${i + 1}.jpg`,
                artist: {
                    id: i < 9 ? "focus-dominant" : `focus-artist-${i + 1}`,
                },
            },
        }));

        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([
            {
                trackGenres: focusTracks.map((track) => ({ track })),
            },
        ]);

        const mix = await service.generateFocusMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(focusTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(2);
        expect(countUniqueArtists(mix!.trackIds, tracksById)).toBeGreaterThanOrEqual(11);
    });

    it("generateArtistSimilarMix handles dominant-artist pools with controlled fallback", async () => {
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
            { track: { album: { artistId: "top-artist-id" } } },
            { track: { album: { artistId: "top-artist-id" } } },
            { track: { album: { artistId: "top-artist-id" } } },
        ]);
        (mockPrisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: "top-artist-id",
            mbid: "top-mbid",
            name: "Top Artist",
        });
        (mockLastFmService.getSimilarArtists as jest.Mock).mockResolvedValue([
            { name: "Dominant Similar" },
            { name: "Similar 2" },
            { name: "Similar 3" },
        ]);

        const dominantTracks: MockTrack[] = Array.from({ length: 8 }, (_, i) => ({
            id: `sim-dominant-${i + 1}`,
            album: {
                coverUrl: `sim-dominant-cover-${i + 1}.jpg`,
                artist: { id: "similar-dominant-artist" },
            },
        }));
        const uniqueTracks: MockTrack[] = Array.from({ length: 17 }, (_, i) => ({
            id: `sim-unique-${i + 1}`,
            album: {
                coverUrl: `sim-unique-cover-${i + 1}.jpg`,
                artist: { id: `similar-artist-${i + 1}` },
            },
        }));

        const libraryArtists = [
            {
                albums: [{ tracks: dominantTracks }],
            },
            ...uniqueTracks.map((track) => ({
                albums: [{ tracks: [track] }],
            })),
        ];
        (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue(libraryArtists);

        const mix = await service.generateArtistSimilarMix("user-1");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);
        expect(mockLastFmService.getSimilarArtists).toHaveBeenCalledWith(
            "top-mbid",
            "Top Artist",
            20
        );

        const allTracks = [...dominantTracks, ...uniqueTracks];
        const tracksById = new Map(allTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(4);
    });

    it("generateRandomDiscoveryMix applies diversity in dominant discovery pools", async () => {
        (mockPrisma.album.count as jest.Mock).mockResolvedValue(100);

        const dominantTracks: MockTrack[] = Array.from({ length: 10 }, (_, i) => ({
            id: `disc-dominant-${i + 1}`,
            album: {
                coverUrl: `disc-dominant-cover-${i + 1}.jpg`,
                artist: { id: "discovery-dominant-artist" },
            },
        }));
        const uniqueTracks: MockTrack[] = Array.from({ length: 16 }, (_, i) => ({
            id: `disc-unique-${i + 1}`,
            album: {
                coverUrl: `disc-unique-cover-${i + 1}.jpg`,
                artist: { id: `discovery-artist-${i + 1}` },
            },
        }));
        const allTracks = [...dominantTracks, ...uniqueTracks];

        (mockPrisma.album.findMany as jest.Mock).mockResolvedValue([
            {
                coverUrl: "album-cover-1.jpg",
                tracks: allTracks.slice(0, 6),
            },
            {
                coverUrl: "album-cover-2.jpg",
                tracks: allTracks.slice(6, 12),
            },
            {
                coverUrl: "album-cover-3.jpg",
                tracks: allTracks.slice(12, 18),
            },
            {
                coverUrl: "album-cover-4.jpg",
                tracks: allTracks.slice(18, 22),
            },
            {
                coverUrl: "album-cover-5.jpg",
                tracks: allTracks.slice(22),
            },
        ]);

        const mix = await service.generateRandomDiscoveryMix("user-1", "2026-02-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(20);

        const tracksById = new Map(allTracks.map((track) => [track.id, track]));
        expect(countMaxPerArtist(mix!.trackIds, tracksById)).toBeLessThanOrEqual(4);
    });

    it("generateRandomDiscoveryMix returns null when total album count is below minimum", async () => {
        (mockPrisma.album.count as jest.Mock).mockResolvedValue(9);

        const mix = await service.generateRandomDiscoveryMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.album.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
    });

    it("generateRandomDiscoveryMix returns null when sampled albums do not provide enough tracks", async () => {
        const oneAlbumTrack = makeTracks(1, "random-discovery-single")[0];

        (mockPrisma.album.count as jest.Mock).mockResolvedValue(12);
        (mockPrisma.album.findMany as jest.Mock).mockResolvedValue([
            {
                coverUrl: "album-cover-1.jpg",
                tracks: [oneAlbumTrack],
            },
        ]);

        const mix = await service.generateRandomDiscoveryMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generatePartyMix falls back through strategies and returns null when still under threshold", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(
                makeTracks(4, "party-album-fallback", { artistGroups: 4 })
            )
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(makeTracks(3, "party-audio-fallback", { artistGroups: 3 }));

        const mix = await service.generatePartyMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(3);
    });
});
