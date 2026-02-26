import { ProgrammaticMix, ProgrammaticPlaylistService } from "../programmaticPlaylists";
import * as programmaticPlaylistArtistCap from "../programmaticPlaylistArtistCap";
import { prisma } from "../../utils/db";
import { lastFmService } from "../lastfm";
import { moodBucketService } from "../moodBucketService";
import { logger } from "../../utils/logger";

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
            count: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
        artist: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
            count: jest.fn(),
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

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/artistNormalization", () => ({
    normalizeArtistName: (name: string) => name.toLowerCase(),
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockLastFmService = lastFmService as jest.Mocked<typeof lastFmService>;
const mockMoodBucketService = moodBucketService as jest.Mocked<typeof moodBucketService>;
const mockLogger = logger as jest.Mocked<typeof logger>;

type TrackLike = {
    id: string;
    valence: number;
    energy: number;
    danceability: number;
    acousticness: number;
    instrumentalness: number;
    arousal: number;
    bpm: number;
    keyScale: "major" | "minor";
    moodTags: string[] | null;
    lastfmTags: string[] | null;
    analysisStatus: "completed";
    moodHappy?: number;
    moodSad?: number;
    moodRelaxed?: number;
    moodAggressive?: number;
    moodParty?: number;
    moodAcoustic?: number;
    moodElectronic?: number;
    album: {
        coverUrl: string | null;
        genres?: string[] | null;
        userGenres?: string[] | null;
        artist: {
            id: string;
            userGenres?: string[] | null;
        };
    };
};

function makeTrack(
    id: string,
    artistId: string,
    overrides: Partial<TrackLike> = {}
): TrackLike {
    const base: TrackLike = {
        id,
        valence: 0.5,
        energy: 0.5,
        danceability: 0.5,
        acousticness: 0.5,
        instrumentalness: 0.5,
        arousal: 0.5,
        bpm: 105,
        keyScale: "major",
        moodTags: null,
        lastfmTags: null,
        analysisStatus: "completed",
        album: {
            coverUrl: `${id}.jpg`,
            genres: ["indie"],
            userGenres: null,
            artist: {
                id: artistId,
                userGenres: null,
            },
        },
    };

    return {
        ...base,
        ...overrides,
        album: {
            ...base.album,
            ...(overrides.album || {}),
            artist: {
                ...base.album.artist,
                ...(overrides.album?.artist || {}),
            },
        },
    };
}

function makeTracks(
    count: number,
    prefix: string,
    options?: {
        artistGroups?: number;
        overrides?: (index: number) => Partial<TrackLike>;
    }
): TrackLike[] {
    const artistGroups = options?.artistGroups ?? Math.max(1, Math.ceil(count / 2));
    return Array.from({ length: count }, (_, index) => {
        const id = `${prefix}-${index + 1}`;
        const artistId = `${prefix}-artist-${index % artistGroups}`;
        return makeTrack(id, artistId, options?.overrides?.(index));
    });
}

function makeMix(type: string, id = `${type}-id`): ProgrammaticMix {
    return {
        id,
        type,
        name: `${type}-name`,
        description: `${type}-description`,
        trackIds: [`${id}-track`],
        coverUrls: [],
        trackCount: 1,
        color: "gradient",
    };
}

const allMixGeneratorMethods: Array<keyof ProgrammaticPlaylistService> = [
    "generateEraMix",
    "generateGenreMix",
    "generateTopTracksMix",
    "generateRediscoverMix",
    "generateArtistSimilarMix",
    "generateRandomDiscoveryMix",
    "generatePartyMix",
    "generateChillMix",
    "generateWorkoutMix",
    "generateFocusMix",
    "generateHighEnergyMix",
    "generateLateNightMix",
    "generateHappyMix",
    "generateMelancholyMix",
    "generateDanceFloorMix",
    "generateAcousticMix",
    "generateInstrumentalMix",
    "generateRoadTripMix",
    "generateDayMix",
    "generateSadGirlSundays",
    "generateMainCharacterEnergy",
    "generateVillainEra",
    "generate3AMThoughts",
    "generateHotGirlWalk",
    "generateRageCleaning",
    "generateGoldenHour",
    "generateShowerKaraoke",
    "generateInMyFeelings",
    "generateMidnightDrive",
    "generateCoffeeShopVibes",
    "generateRomanticizeYourLife",
    "generateThatGirlEra",
    "generateUnhinged",
    "generateDeepCuts",
    "generateKeyJourney",
    "generateTempoFlow",
    "generateVocalDetox",
    "generateMinorKeyMix",
];

describe("ProgrammaticPlaylistService behavior coverage", () => {
    let service: ProgrammaticPlaylistService;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        service = new ProgrammaticPlaylistService();

        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue([]);
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.trackGenre.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.artist.findUnique as jest.Mock).mockResolvedValue(null);
        (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.album.count as jest.Mock).mockResolvedValue(0);
        (mockMoodBucketService.getUserMoodMix as jest.Mock).mockResolvedValue(null);
        (mockLastFmService.getSimilarArtists as jest.Mock).mockResolvedValue([]);
    });

    it("generateAllMixes backfills from fallback generators, de-duplicates by type, and appends saved mood mix", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00Z"));

        let invocationCount = 0;
        for (const method of allMixGeneratorMethods) {
            jest.spyOn(service as any, method).mockImplementation(async () => {
                invocationCount += 1;
                if (invocationCount <= 5) {
                    return null;
                }
                return makeMix("fallback-duplicate", `fallback-${invocationCount}`);
            });
        }

        (mockMoodBucketService.getUserMoodMix as jest.Mock).mockResolvedValue(
            makeMix("saved-mood", "saved-mood-id")
        );

        const mixes = await service.generateAllMixes("user-1");

        expect(invocationCount).toBeGreaterThan(5);
        expect(mixes.filter((mix) => mix.type === "fallback-duplicate")).toHaveLength(1);
        expect(mixes).toHaveLength(2);
        expect(mixes[1].id).toBe("saved-mood-id");
        expect(mockMoodBucketService.getUserMoodMix).toHaveBeenCalledWith("user-1");
    });

    it("generateAllMixes returns generated mixes even if mood bucket lookup errors", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00Z"));

        for (const method of allMixGeneratorMethods) {
            jest.spyOn(service as any, method).mockResolvedValue(null);
        }

        (mockMoodBucketService.getUserMoodMix as jest.Mock).mockRejectedValue(
            new Error("redis unavailable")
        );

        const mixes = await service.generateAllMixes("user-2");

        expect(mixes).toEqual([]);
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[MIXES] Error getting user's saved mood mix:",
            expect.any(Error)
        );
    });

    it("generateAllMixes skips fallback when selected mixes already satisfy daily quota", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00Z"));

        const calledMethods: string[] = [];
        for (const method of allMixGeneratorMethods) {
            jest.spyOn(service as any, method).mockImplementation(async () => {
                calledMethods.push(method);
                return makeMix(method);
            });
        }

        const mixes = await service.generateAllMixes("user-1");

        expect(calledMethods).toHaveLength(5);
        expect(new Set(calledMethods).size).toBe(5);
        expect(mixes).toHaveLength(5);
    });

    it("generateAllMixes forceRandom mode is deterministic for a fixed seed input", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-17T12:00:00Z"));
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.25);

        for (const method of allMixGeneratorMethods) {
            jest
                .spyOn(service as any, method)
                .mockResolvedValue(makeMix(method, `${method}-force-random`));
        }

        const firstRun = await service.generateAllMixes("user-1", true);
        const secondRun = await service.generateAllMixes("user-1", true);

        expect(firstRun.map((mix) => mix.type)).toEqual(
            secondRun.map((mix) => mix.type)
        );
        expect(firstRun.map((mix) => mix.id)).toEqual(secondRun.map((mix) => mix.id));
        randomSpy.mockRestore();
    });

    it("generateTopTracksMix preserves ranked surviving tracks when catalog lookup misses played IDs", async () => {
        const playStats = Array.from({ length: 10 }, (_, i) => ({
            trackId: `track-${i + 1}`,
            _count: { trackId: 20 - i },
        }));
        const rankedLookupTracks = makeTracks(4, "track", {
            artistGroups: 4,
        });
        const fallbackTracks = makeTracks(30, "top-fallback", { artistGroups: 30 });
        let trackFindCalls = 0;

        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(playStats);
        (mockPrisma.track.findMany as jest.Mock).mockImplementation(async () => {
            trackFindCalls += 1;
            return trackFindCalls === 1 ? rankedLookupTracks : fallbackTracks;
        });

        const mix = await service.generateTopTracksMix("user-1");

        expect(mix).not.toBeNull();
        expect(mix!.trackIds.slice(0, 4)).toEqual([
            "track-1",
            "track-2",
            "track-3",
            "track-4",
        ]);
        expect(mix!.trackIds).toHaveLength(20);
        expect(mix!.trackIds.some((id) => id.startsWith("top-fallback-"))).toBe(true);
        expect(trackFindCalls).toBe(2);
    });

    it("handles missing artist ids in diversify helpers via unknown fallback keys", async () => {
        const applyArtistCapSpy = jest
            .spyOn(programmaticPlaylistArtistCap, "applyArtistCap")
            .mockImplementation((tracks: any[]) => tracks as any);
        const missingArtistTrack = makeTrack("missing-artist-1", "seed-artist", {
            album: {
                coverUrl: "missing-artist-1.jpg",
                artist: {
                    id: undefined as any,
                },
            },
        });
        const secondMissingArtistTrack = makeTrack(
            "missing-artist-2",
            "seed-artist",
            {
                album: {
                    coverUrl: "missing-artist-2.jpg",
                    artist: {
                        id: undefined as any,
                    },
                },
            }
        );
        const noAlbumTrack = {
            ...makeTrack("missing-artist-no-album", "seed-artist"),
            album: undefined,
        } as unknown as TrackLike;
        const validArtistTrack = makeTrack("valid-artist", "valid-artist");

        const diversified = (service as any).diversifyTracks(
            [missingArtistTrack],
            1,
            "seed-diversify-missing"
        );
        expect(diversified.map((track: TrackLike) => track.id)).toEqual([
            "missing-artist-1",
        ]);
        const diversifiedNoAlbum = (service as any).diversifyTracks(
            [noAlbumTrack],
            1,
            "seed-diversify-no-album"
        );
        expect(diversifiedNoAlbum.map((track: TrackLike) => track.id)).toEqual([
            "missing-artist-no-album",
        ]);

        const uniqueFirst = (service as any).diversifyTracksUniqueFirst(
            [missingArtistTrack],
            1,
            "seed-unique-first-missing"
        );
        expect(uniqueFirst.map((track: TrackLike) => track.id)).toEqual([
            "missing-artist-1",
        ]);

        const uniqueSecondPass = (service as any).diversifyTracksUniqueFirst(
            [missingArtistTrack, secondMissingArtistTrack],
            2,
            "seed-unique-second-pass-missing"
        );
        expect(uniqueSecondPass).toHaveLength(2);
        const uniqueSecondPassNoAlbum = (service as any).diversifyTracksUniqueFirst(
            [noAlbumTrack, validArtistTrack],
            2,
            "seed-unique-second-pass-no-album"
        );
        expect(uniqueSecondPassNoAlbum).toHaveLength(2);

        const earlyBackfill = await (service as any).backfillFromLibraryForDiversity(
            [validArtistTrack, missingArtistTrack],
            1,
            "seed-backfill-early"
        );
        expect(earlyBackfill).toHaveLength(2);

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValueOnce(
            makeTracks(12, "backfill-missing", {
                artistGroups: 6,
                overrides: (index) => ({
                    album: {
                        coverUrl: `backfill-missing-${index}.jpg`,
                        artist: {
                            id:
                                index % 2 === 0 ?
                                    (undefined as any)
                                :   `backfill-artist-${index}`,
                        },
                    },
                }),
            })
        );
        const fullBackfill = await (service as any).backfillFromLibraryForDiversity(
            [missingArtistTrack],
            6,
            "seed-backfill-full"
        );
        expect(fullBackfill.length).toBeGreaterThan(0);
        expect(mockPrisma.track.findMany).toHaveBeenCalled();
        applyArtistCapSpy.mockRestore();
    });

    it("generateTopTracksMix handles ranked and fallback tracks without artist ids", async () => {
        const playStats = Array.from({ length: 10 }, (_, i) => ({
            trackId: `missing-top-${i + 1}`,
            _count: { trackId: 20 - i },
        }));
        const rankedLookupTracks = [
            makeTrack("missing-top-1", "ranked-a", {
                album: {
                    coverUrl: "missing-top-1.jpg",
                    artist: { id: undefined as any },
                },
            }),
            makeTrack("missing-top-2", "ranked-b", {
                album: {
                    coverUrl: "missing-top-2.jpg",
                    artist: { id: undefined as any },
                },
            }),
            makeTrack("missing-top-3", "ranked-c", {
                album: {
                    coverUrl: "missing-top-3.jpg",
                    artist: { id: undefined as any },
                },
            }),
        ];
        const fallbackTracks = makeTracks(30, "missing-top-fallback", {
            artistGroups: 30,
            overrides: (index) => ({
                album: {
                    coverUrl: `missing-top-fallback-${index}.jpg`,
                    artist: {
                        id:
                            index % 3 === 0 ?
                                (undefined as any)
                            :   `missing-top-fallback-artist-${index}`,
                    },
                },
            }),
        });
        let trackFindCalls = 0;

        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(playStats);
        (mockPrisma.track.findMany as jest.Mock).mockImplementation(async () => {
            trackFindCalls += 1;
            return trackFindCalls === 1 ? rankedLookupTracks : fallbackTracks;
        });

        const mix = await service.generateTopTracksMix("user-1");

        expect(mix).not.toBeNull();
        expect(mix!.trackIds.slice(0, 3)).toEqual([
            "missing-top-1",
            "missing-top-2",
            "missing-top-3",
        ]);
        expect(mix!.trackIds).toHaveLength(20);
        expect(trackFindCalls).toBe(2);
    });

    it("forces diversify unknown-artist fallback branches with isolated artist-cap passthrough mocks", () => {
        jest.resetModules();
        jest.isolateModules(() => {
            const applyArtistCapMock = jest.fn((tracks: any[], options?: any) => {
                if (options?.maxPerArtist === 1) {
                    return tracks.slice(0, 1);
                }
                return tracks;
            });

            jest.doMock("../programmaticPlaylistArtistCap", () => ({
                applyArtistCap: applyArtistCapMock,
            }));

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const isolated = require("../programmaticPlaylists");
            const IsolatedService = isolated.ProgrammaticPlaylistService;
            const isolatedService = new IsolatedService();
            const unknownArtistTracks = [
                {
                    id: "iso-track-1",
                    album: { artist: { id: null } },
                },
                {
                    id: "iso-track-2",
                    album: {},
                },
            ];

            const diversified = (isolatedService as any).diversifyTracks(
                unknownArtistTracks,
                2,
                "iso-diversify"
            );
            expect(diversified).toHaveLength(2);

            const uniqueFirst = (isolatedService as any).diversifyTracksUniqueFirst(
                unknownArtistTracks,
                2,
                "iso-unique"
            );
            expect(uniqueFirst).toHaveLength(2);
            expect(applyArtistCapMock).toHaveBeenCalled();
        });
    });

    it("generateDayMix returns null on non-scheduled weekdays", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-02-18T12:00:00Z")); // Wednesday

        const mix = await service.generateDayMix("user-1");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
    });

    it("generateGenreMix returns null when no genre has enough tracks", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([
            { id: "genre-1", name: "dream pop", _count: { trackGenres: 4 } },
        ]);

        const mix = await service.generateGenreMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.trackGenre.findMany).not.toHaveBeenCalled();
    });

    it("generateGenreMix returns null when fallback genre scan fails to reach minimum", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([
            { id: "genre-2", name: "ambient", _count: { trackGenres: 5 } },
        ]);
        (mockPrisma.trackGenre.findMany as jest.Mock).mockResolvedValue([]);

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(4, "genre-fallback-low", { artistGroups: 4 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateGenreMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(2);
    });

    it("generateTopTracksMix returns null for users with fewer than five played tracks", async () => {
        (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue([
            { trackId: "track-1", _count: { trackId: 4 } },
            { trackId: "track-2", _count: { trackId: 3 } },
            { trackId: "track-3", _count: { trackId: 2 } },
            { trackId: "track-4", _count: { trackId: 1 } },
        ]);

        const mix = await service.generateTopTracksMix("user-1");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
    });

    it("generateEraMix returns null when no valid decade can be resolved", async () => {
        (mockPrisma.album.findMany as jest.Mock).mockResolvedValue([
            { year: null, originalYear: null, displayYear: null },
            { year: null, originalYear: null, displayYear: null },
        ]);

        const mix = await service.generateEraMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).not.toHaveBeenCalled();
    });

    it("generateArtistSimilarMix returns null when there are no recent plays", async () => {
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([]);

        const mix = await service.generateArtistSimilarMix("user-1");

        expect(mix).toBeNull();
        expect(mockLastFmService.getSimilarArtists).not.toHaveBeenCalled();
    });

    it("generateArtistSimilarMix selects most recent top artist by play count", async () => {
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
            { track: { album: { artistId: "artist-a" } } },
            { track: { album: { artistId: "artist-a" } } },
            { track: { album: { artistId: "artist-b" } } },
            { track: { album: { artistId: "artist-b" } } },
            { track: { album: { artistId: "artist-b" } } },
            { track: { album: { artistId: "artist-c" } } },
        ]);
        (mockPrisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: "artist-b",
            name: "Beta Band",
            mbid: "beta-mbid",
        });
        (mockLastFmService.getSimilarArtists as jest.Mock).mockResolvedValue([
            { name: "similar-one" },
            { name: "similar-two" },
        ]);

        const libraryTracks = makeTracks(6, "artist-similar-lib", {
            artistGroups: 6,
        });
        (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue(
            libraryTracks.map((track) => ({
                albums: [{ tracks: [track] }],
            }))
        );

        const mix = await service.generateArtistSimilarMix("user-1");

        expect(mix).not.toBeNull();
        expect(mockPrisma.artist.findUnique).toHaveBeenCalledWith({
            where: { id: "artist-b" },
        });
        expect(mockLastFmService.getSimilarArtists).toHaveBeenCalledWith(
            "beta-mbid",
            "Beta Band",
            20
        );
    });

    it("generateArtistSimilarMix returns null when top artist record is missing required name", async () => {
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
            { track: { album: { artistId: "artist-1" } } },
            { track: { album: { artistId: "artist-1" } } },
        ]);
        (mockPrisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: "artist-1",
            name: null,
            mbid: "artist-1-mbid",
        });

        const mix = await service.generateArtistSimilarMix("user-1");

        expect(mix).toBeNull();
        expect(mockLastFmService.getSimilarArtists).not.toHaveBeenCalled();
    });

    it("generateArtistSimilarMix returns null when similar artists in library have too few tracks", async () => {
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
            { track: { album: { artistId: "artist-1" } } },
            { track: { album: { artistId: "artist-1" } } },
            { track: { album: { artistId: "artist-1" } } },
        ]);
        (mockPrisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: "artist-1",
            name: "Anchor Artist",
            mbid: null,
        });
        (mockLastFmService.getSimilarArtists as jest.Mock).mockResolvedValue([
            { name: "similar one" },
            { name: "similar two" },
        ]);
        (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue([
            {
                albums: [{ tracks: makeTracks(4, "similar", { artistGroups: 4 }) }],
            },
        ]);

        const mix = await service.generateArtistSimilarMix("user-1");

        expect(mix).toBeNull();
    });

    it("generateRediscoverMix returns null when underplayed tracks are below threshold", async () => {
        const tracks = Array.from({ length: 4 }, (_, index) =>
            ({
                ...makeTrack(`underplayed-${index + 1}`, `underplayed-artist-${index + 1}`),
                _count: { plays: 2 },
            } as TrackLike & { _count: { plays: number } })
        );

        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

        const mix = await service.generateRediscoverMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateArtistSimilarMix handles Last.fm failures and returns null", async () => {
        (mockPrisma.play.findMany as jest.Mock).mockResolvedValue([
            { track: { album: { artistId: "artist-1" } } },
        ]);
        (mockPrisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: "artist-1",
            name: "Anchor Artist",
            mbid: "anchor-mbid",
        });
        (mockLastFmService.getSimilarArtists as jest.Mock).mockRejectedValue(
            new Error("lastfm timeout")
        );

        const mix = await service.generateArtistSimilarMix("user-1");

        expect(mix).toBeNull();
    });

    it("generateFocusMix runs genre and audio fallback chain and fails when candidates remain under threshold", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                makeTrack("scan-empty-1", "scan-artist-1", {
                    album: {
                        coverUrl: "scan-empty-1.jpg",
                        genres: null,
                        userGenres: null,
                        artist: { id: "scan-artist-1", userGenres: null },
                    },
                }),
            ])
            .mockResolvedValueOnce(makeTracks(4, "focus-audio", { artistGroups: 4 }));

        const mix = await service.generateFocusMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                where: expect.objectContaining({
                    analysisStatus: "completed",
                    instrumentalness: { gte: 0.5 },
                }),
            })
        );
    });

    it("generateHighEnergyMix falls back to genre discovery and returns null when still under minimum", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(3, "high-energy-audio", { artistGroups: 3 }))
            .mockResolvedValueOnce(makeTracks(2, "high-energy-genre", { artistGroups: 2 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateHighEnergyMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(3);
    });

    it("generateLateNightMix returns null when enhanced and standard pools are both too small", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(3, "late-enhanced", { artistGroups: 3 }))
            .mockResolvedValueOnce(makeTracks(7, "late-standard", { artistGroups: 7 }));

        const mix = await service.generateLateNightMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateHappyMix exhausts standard and genre fallbacks before returning null", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(2, "happy-enhanced", { artistGroups: 2 }))
            .mockResolvedValueOnce(makeTracks(4, "happy-standard", { artistGroups: 4 }))
            .mockResolvedValueOnce(makeTracks(3, "happy-genre", { artistGroups: 3 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateHappyMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateMelancholyMix applies standard-mode filtering and still returns null when under threshold", async () => {
        const standardCandidates = [
            makeTrack("mel-a", "artist-a", { keyScale: "minor" }),
            makeTrack("mel-b", "artist-b", { moodTags: ["melancholy"] }),
            makeTrack("mel-c", "artist-c", { lastfmTags: ["heartbreak"] }),
            makeTrack("mel-d", "artist-d", {
                keyScale: "major",
                moodTags: ["uplifting"],
                lastfmTags: ["happy"],
            }),
            makeTrack("mel-e", "artist-e", { keyScale: "major" }),
            makeTrack("mel-f", "artist-f", {
                keyScale: "major",
                moodTags: ["energetic"],
                lastfmTags: ["party"],
            }),
        ];

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(2, "melancholy-enhanced", { artistGroups: 2 }))
            .mockResolvedValueOnce(standardCandidates)
            .mockResolvedValueOnce(makeTracks(2, "melancholy-genre", { artistGroups: 2 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateMelancholyMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it.each([
        {
            label: "dance floor",
            run: (playlistService: ProgrammaticPlaylistService) =>
                playlistService.generateDanceFloorMix("user-1", "2026-02-17"),
        },
        {
            label: "acoustic",
            run: (playlistService: ProgrammaticPlaylistService) =>
                playlistService.generateAcousticMix("user-1", "2026-02-17"),
        },
        {
            label: "instrumental",
            run: (playlistService: ProgrammaticPlaylistService) =>
                playlistService.generateInstrumentalMix("user-1", "2026-02-17"),
        },
    ])(
        "generate%s mix returns null when audio plus genre fallback pools stay under minimum",
        async ({ label, run }) => {
            (mockPrisma.track.findMany as jest.Mock)
                .mockResolvedValueOnce(makeTracks(3, `${label}-audio`, { artistGroups: 3 }))
                .mockResolvedValueOnce(makeTracks(2, `${label}-genre`, { artistGroups: 2 }))
                .mockResolvedValueOnce([]);

            const mix = await run(service);

            expect(mix).toBeNull();
        }
    );

    it("generateWorkoutMix executes all fallback layers and returns null when still under 15 tracks", async () => {
        const genreTracks = makeTracks(4, "workout-genre", { artistGroups: 4 });

        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([
            {
                trackGenres: genreTracks.map((track) => ({ track })),
            },
        ]);

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(4, "workout-enhanced", { artistGroups: 4 }))
            .mockResolvedValueOnce(makeTracks(3, "workout-audio", { artistGroups: 3 }))
            .mockResolvedValueOnce(makeTracks(2, "workout-album-genre", { artistGroups: 2 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateWorkoutMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateChillMix can fail after diversity filtering even when raw candidates meet minimum", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(8, "chill-enhanced", { artistGroups: 1 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateChillMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateChillMix falls back to standard mode when enhanced coverage is insufficient", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(5, "chill-enhanced", { artistGroups: 5 }))
            .mockResolvedValueOnce(makeTracks(7, "chill-standard", { artistGroups: 7 }));

        const mix = await service.generateChillMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
        expect((mockPrisma.track.findMany as jest.Mock).mock.calls[1][0].where).toEqual(
            expect.objectContaining({
                analysisStatus: "completed",
                AND: expect.arrayContaining([expect.any(Object)]),
            })
        );
        expect((mockPrisma.track.findMany as jest.Mock).mock.calls[1][0].take).toBe(100);
    });

    it("generateFocusMix uses album-pattern and audio fallbacks before returning a mix", async () => {
        (mockPrisma.genre.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(10, "focus-fallback-album", { artistGroups: 10 }))
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(makeTracks(20, "focus-fallback-audio", { artistGroups: 20 }));

        const mix = await service.generateFocusMix("user-1", "2026-02-17");

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(20);
        expect(mockPrisma.track.findMany).toHaveBeenCalledTimes(3);
    });

    it("generateRoadTripMix returns null after exhausting tag, audio, and genre fallback paths", async () => {
        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(makeTracks(5, "road-tagged", { artistGroups: 5 }))
            .mockResolvedValueOnce(makeTracks(4, "road-audio", { artistGroups: 4 }))
            .mockResolvedValueOnce(makeTracks(3, "road-genre", { artistGroups: 3 }))
            .mockResolvedValueOnce([]);

        const mix = await service.generateRoadTripMix("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateCoffeeShopVibes returns null when strict criteria produce fewer than 8 tracks", async () => {
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValueOnce(
            makeTracks(7, "coffee-low", { artistGroups: 7 })
        );

        const mix = await service.generateCoffeeShopVibes("user-1", "2026-02-17");

        expect(mix).toBeNull();
    });

    it("generateCoffeeShopVibes enforces strict query and backfills to a 10-track mix", async () => {
        const initialTracks = makeTracks(8, "coffee-initial", { artistGroups: 4 });
        const backfillTracks = makeTracks(30, "coffee-backfill", { artistGroups: 30 });

        (mockPrisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce(initialTracks)
            .mockResolvedValueOnce(backfillTracks);

        const mix = await service.generateCoffeeShopVibes("user-1", "2026-02-17");

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(10);

        const strictQuery = (mockPrisma.track.findMany as jest.Mock).mock.calls[0][0];
        expect(strictQuery.where.AND).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    NOT: expect.objectContaining({
                        OR: expect.any(Array),
                    }),
                }),
            ])
        );

        const backfillQuery = (mockPrisma.track.findMany as jest.Mock).mock.calls[1][0];
        expect(backfillQuery.take).toBe(500);
        expect(backfillQuery.where.id.notIn.length).toBeGreaterThan(0);
    });

    it("generateMoodOnDemand maps ML mood requests into basic feature bounds when enhanced coverage is insufficient", async () => {
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(4);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(12, "mood-fallback", { artistGroups: 6 })
        );

        const mix = await service.generateMoodOnDemand("user-1", {
            moodHappy: { min: 0.3 },
            moodSad: { min: 0.6 },
            moodRelaxed: { min: 0.8 },
            moodAggressive: { min: 0.4 },
            moodParty: { min: 0.2 },
            valence: { max: 0.7 },
            energy: { max: 0.9 },
            danceability: { max: 0.95 },
            limit: 10,
        });

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(10);

        const moodWhere = (mockPrisma.track.findMany as jest.Mock).mock.calls[0][0].where;
        expect(moodWhere.valence).toEqual({ gte: 0.3, lte: 0.4 });
        expect(moodWhere.energy).toEqual({ gte: 0.4, lte: 0.6 });
        expect(moodWhere.danceability).toEqual({ gte: 0.2, lte: 0.95 });
        expect(moodWhere.moodHappy).toBeUndefined();
        expect(moodWhere.moodSad).toBeUndefined();
        expect(moodWhere.moodRelaxed).toBeUndefined();
        expect(moodWhere.moodAggressive).toBeUndefined();
    });

    it("generateMoodOnDemand composes enhanced-mode filters across basic and ML mood min/max bounds", async () => {
        (mockPrisma.track.count as jest.Mock).mockResolvedValue(30);
        (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(
            makeTracks(18, "mood-enhanced", {
                artistGroups: 9,
                overrides: () => ({
                    moodHappy: 0.8,
                    moodSad: 0.2,
                    moodRelaxed: 0.6,
                    moodAggressive: 0.3,
                    moodParty: 0.7,
                    moodAcoustic: 0.5,
                    moodElectronic: 0.4,
                }),
            })
        );

        const mix = await service.generateMoodOnDemand("user-1", {
            valence: { min: 0.2, max: 0.6 },
            energy: { min: 0.3, max: 0.8 },
            danceability: { min: 0.4, max: 0.9 },
            acousticness: { min: 0.1, max: 0.7 },
            instrumentalness: { min: 0.05, max: 0.6 },
            arousal: { min: 0.2, max: 0.75 },
            bpm: { min: 80, max: 135 },
            keyScale: "minor",
            moodHappy: { min: 0.5, max: 0.9 },
            moodSad: { min: 0.1, max: 0.4 },
            moodRelaxed: { min: 0.2, max: 0.8 },
            moodAggressive: { min: 0.1, max: 0.7 },
            moodParty: { min: 0.3, max: 0.95 },
            moodAcoustic: { min: 0.2, max: 0.9 },
            moodElectronic: { min: 0.15, max: 0.85 },
            limit: 16,
        });

        expect(mix).not.toBeNull();
        expect(mix!.trackCount).toBe(16);

        const query = (mockPrisma.track.findMany as jest.Mock).mock.calls[0][0];
        expect(query.where.analysisMode).toBe("enhanced");
        expect(query.where.analysisVersion).toEqual({
            startsWith: "2.1b6-enhanced-v3",
        });
        expect(query.where.acousticness).toEqual({ gte: 0.1, lte: 0.7 });
        expect(query.where.instrumentalness).toEqual({ gte: 0.05, lte: 0.6 });
        expect(query.where.arousal).toEqual({ gte: 0.2, lte: 0.75 });
        expect(query.where.bpm).toEqual({ gte: 80, lte: 135 });
        expect(query.where.moodHappy).toEqual({ gte: 0.5, lte: 0.9 });
        expect(query.where.moodSad).toEqual({ gte: 0.1, lte: 0.4 });
        expect(query.where.moodRelaxed).toEqual({ gte: 0.2, lte: 0.8 });
        expect(query.where.moodAggressive).toEqual({ gte: 0.1, lte: 0.7 });
        expect(query.where.moodParty).toEqual({ gte: 0.3, lte: 0.95 });
        expect(query.where.moodAcoustic).toEqual({ gte: 0.2, lte: 0.9 });
        expect(query.where.moodElectronic).toEqual({ gte: 0.15, lte: 0.85 });
    });
});
