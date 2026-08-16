import type { Prisma } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { logger } from "../../utils/logger";
import { separateArtists } from "../../utils/separateArtists";
import {
    allocateTracksWithArtistWeighting,
    createSeededRng,
    getSeededRandom,
    seededShuffle,
} from "../artistSlotAllocation";
import {
    applyArtistCap,
    type ArtistCapTrack,
} from "../programmaticPlaylistArtistCap";

export interface ProgrammaticMix {
    id: string;
    type: string;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[]; // For mosaic cover art
    trackCount: number;
    color: string; // Tailwind gradient classes for mood-reflective hero
}

// Research-based color psychology for mix vibes
// Using actual CSS rgba values for inline styles (Tailwind classes get purged at build time)
const MIX_COLORS: Record<string, string> = {
    // Night/Introspection - Deep blues and purples for calm, night sky, solitude
    "late-night":
        "linear-gradient(to bottom, rgba(30, 27, 75, 0.7), rgba(30, 58, 138, 0.5), rgba(15, 23, 42, 0.4))",
    "3am-thoughts":
        "linear-gradient(to bottom, rgba(46, 16, 101, 0.7), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "night-drive":
        "linear-gradient(to bottom, rgba(15, 23, 42, 0.7), rgba(49, 46, 129, 0.5), rgba(88, 28, 135, 0.4))",

    // Calm/Relaxation - Teal and seafoam for spa-like tranquility
    chill: "linear-gradient(to bottom, rgba(17, 94, 89, 0.6), rgba(22, 78, 99, 0.5), rgba(15, 23, 42, 0.4))",
    "coffee-shop":
        "linear-gradient(to bottom, rgba(120, 53, 15, 0.6), rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4))",
    "rainy-day":
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(31, 41, 55, 0.5), rgba(39, 39, 42, 0.4))",
    "sunday-morning":
        "linear-gradient(to bottom, rgba(253, 186, 116, 0.4), rgba(252, 211, 77, 0.3), rgba(68, 64, 60, 0.4))",

    // Energy/Workout - Red and orange to increase heart rate
    workout:
        "linear-gradient(to bottom, rgba(153, 27, 27, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    "confidence-boost":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(68, 64, 60, 0.4))",

    // Happy/Uplifting - Yellow and warm amber for optimism
    happy: "linear-gradient(to bottom, rgba(217, 119, 6, 0.5), rgba(161, 98, 7, 0.4), rgba(68, 64, 60, 0.4))",
    "summer-vibes":
        "linear-gradient(to bottom, rgba(8, 145, 178, 0.5), rgba(15, 118, 110, 0.4), rgba(30, 58, 138, 0.4))",
    "golden-hour":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(234, 88, 12, 0.4), rgba(136, 19, 55, 0.4))",

    // Sad/Melancholy - Cool blue-grays for "feeling blue"
    melancholy:
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(30, 58, 138, 0.5), rgba(17, 24, 39, 0.4))",
    "sad-girl-sundays":
        "linear-gradient(to bottom, rgba(136, 19, 55, 0.5), rgba(30, 41, 59, 0.5), rgba(59, 7, 100, 0.4))",
    "heartbreak-hotel":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",

    // Party/Dance - Hot pink and magenta for club energy
    "dance-floor":
        "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",

    // Acoustic/Organic - Warm browns like wood instruments
    acoustic:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    unplugged:
        "linear-gradient(to bottom, rgba(68, 64, 60, 0.6), rgba(120, 53, 15, 0.5), rgba(38, 38, 38, 0.4))",

    // Focus/Instrumental - Purple for creativity and concentration
    instrumental:
        "linear-gradient(to bottom, rgba(91, 33, 182, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "focus-flow":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(30, 41, 59, 0.5), rgba(17, 24, 39, 0.4))",

    // Adventure/Road Trip - Sunset oranges for freedom
    "road-trip":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(14, 165, 233, 0.4))",

    // Character/Mood Archetypes
    "main-character":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(202, 138, 4, 0.4), rgba(124, 45, 18, 0.4))",
    "villain-era":
        "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",

    // Nostalgia - Sepia and vintage tones
    throwback:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.5), rgba(124, 45, 18, 0.4), rgba(68, 64, 60, 0.4))",

    // Genre/Era based - More neutral but themed
    era: "linear-gradient(to bottom, rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4), rgba(39, 39, 42, 0.4))",
    genre: "linear-gradient(to bottom, rgba(63, 63, 70, 0.5), rgba(30, 41, 59, 0.4), rgba(17, 24, 39, 0.4))",
    "top-tracks":
        "linear-gradient(to bottom, rgba(6, 95, 70, 0.5), rgba(17, 94, 89, 0.4), rgba(15, 23, 42, 0.4))",
    rediscover:
        "linear-gradient(to bottom, rgba(55, 48, 163, 0.5), rgba(76, 29, 149, 0.4), rgba(15, 23, 42, 0.4))",
    "artist-similar":
        "linear-gradient(to bottom, rgba(107, 33, 168, 0.5), rgba(112, 26, 117, 0.4), rgba(15, 23, 42, 0.4))",
    discovery:
        "linear-gradient(to bottom, rgba(2, 132, 199, 0.5), rgba(30, 58, 138, 0.4), rgba(15, 23, 42, 0.4))",

    // Mood-on-demand default
    mood: "linear-gradient(to bottom, rgba(162, 28, 175, 0.5), rgba(107, 33, 168, 0.4), rgba(15, 23, 42, 0.4))",

    // Default fallback
    default:
        "linear-gradient(to bottom, rgba(88, 28, 135, 0.4), rgba(26, 26, 26, 1), transparent)",
};

// Mood head class-column polarity was corrected in analyzer v3.
// Only trust enhanced mood-head fields from this version onward.
export const RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX = "2.1b6-enhanced-v3";

// Helper to get color for a mix type
export function getMixColor(type: string): string {
    return MIX_COLORS[type] || MIX_COLORS["default"];
}

// Seeded RNG utilities live in the pure artistSlotAllocation module
// (config-free import chain); re-exported here for existing consumers.
export { seededShuffle };

/**
 * Shared diverse selection for mix generators (GH #46): replaces the raw
 * seededShuffle(...).slice(...) / randomSample(...) pattern with the
 * damped proportional artist allocator. Artist keys come from a single
 * batched album lookup (pool track objects carry albumId but not the
 * artist), so no per-generator select changes are needed. Deterministic
 * when a seedKey is provided (daily/weekly mixes stay stable per seed).
 */
/** Unknown-safe read of an inline album.artist.id on a pool track. */
function readInlineArtistId(track: unknown): string | undefined {
    const album = (
        track as { album?: { artist?: { id?: unknown } | null } | null }
    ).album;
    const id = album?.artist?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

export async function selectTracksWithArtistDiversityForMix<
    T extends { id: string; albumId?: string | null },
>(tracks: T[], count: number, seedKey?: string): Promise<T[]> {
    if (!Array.isArray(tracks) || tracks.length === 0 || count <= 0) {
        return [];
    }
    // Artist keys prefer an inline album.artist.id (some pool selects
    // include it); only tracks without one need the batched album lookup.
    const albumIds = [
        ...new Set(
            tracks
                .filter((track) => !readInlineArtistId(track))
                .map((track) => track.albumId)
                .filter((id): id is string => typeof id === "string"),
        ),
    ];
    const albums =
        albumIds.length > 0
            ? await prisma.album.findMany({
                  where: { id: { in: albumIds } },
                  select: { id: true, artistId: true },
              })
            : [];
    const artistByAlbumId = new Map(albums.map((a) => [a.id, a.artistId]));
    const rng = seedKey
        ? createSeededRng(getSeededRandom(seedKey))
        : Math.random;
    return allocateTracksWithArtistWeighting(
        tracks,
        (track, index) =>
            readInlineArtistId(track) ||
            (track.albumId && artistByAlbumId.get(track.albumId)) ||
            `unknown:${index}`,
        {
            targetCount: count,
            alpha: config.generationDiversity.weightAlpha,
            ceilingShare: config.generationDiversity.shareCeiling,
            rng,
        },
    );
}

// Type for track with album cover
export type TrackWithAlbumCover = {
    id: string;
    album: {
        coverUrl: string | null;
        genres?: unknown;
        userGenres?: string[] | null;
        artist?: {
            id?: string;
            userGenres?: string[] | null;
        };
    };
    lastfmTags?: string[];
    essentiaGenres?: string[];
    [key: string]: unknown;
};

/**
 * Helper to find tracks matching genre patterns.
 * Uses lastfmTags and essentiaGenres on tracks (String[]) first,
 * then falls back to filtering album.genres (JSON array) in memory.
 */
export async function findTracksByGenrePatterns(
    genrePatterns: string[],
    limit: number = 100,
): Promise<TrackWithAlbumCover[]> {
    // Strategy 1: Use track's lastfmTags and essentiaGenres (native String[] fields)
    const tagPatterns = genrePatterns.map((g) => g.toLowerCase());

    const tracks = await prisma.track.findMany({
        where: {
            ...TRACK_VISIBLE_WHERE,
            ...TRACK_BROWSE_WHERE,
            OR: [
                { lastfmTags: { hasSome: tagPatterns } },
                { essentiaGenres: { hasSome: tagPatterns } },
            ],
        },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            id: true,
                            userGenres: true,
                        },
                    },
                },
            },
        },
        take: limit,
    });

    if (tracks.length >= 15) {
        return tracks as TrackWithAlbumCover[];
    }

    // Strategy 2: Paged scan over canonical + user genres to avoid first-page bias.
    const genreMatched: TrackWithAlbumCover[] = [];
    const batchSize = 100;
    let cursorId: string | undefined;

    while (genreMatched.length + tracks.length < limit) {
        const albumTracks = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                album: {
                    OR: [
                        { genres: { not: { equals: null } } },
                        { userGenres: { not: { equals: null } } },
                        {
                            artist: {
                                userGenres: { not: { equals: null } },
                            },
                        },
                    ],
                },
            },
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        genres: true,
                        userGenres: true,
                        artist: {
                            select: {
                                id: true,
                                userGenres: true,
                            },
                        },
                    },
                },
            },
            orderBy: { id: "asc" },
            take: batchSize,
            ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        if (albumTracks.length === 0) {
            break;
        }

        for (const track of albumTracks) {
            const albumGenres = track.album.genres as string[] | null;
            const albumUserGenres =
                (track.album.userGenres as string[] | null) || [];
            const artistUserGenres =
                (track.album.artist?.userGenres as string[] | null) || [];
            const allGenres = [
                ...(albumGenres || []),
                ...albumUserGenres,
                ...artistUserGenres,
            ];
            if (allGenres.length === 0) {
                continue;
            }

            const isMatch = allGenres.some((ag) =>
                genrePatterns.some((gp) =>
                    ag.toLowerCase().includes(gp.toLowerCase()),
                ),
            );
            if (isMatch) {
                genreMatched.push(track as TrackWithAlbumCover);
            }
        }

        if (albumTracks.length < batchSize) {
            break;
        }
        cursorId = albumTracks[albumTracks.length - 1].id;
    }

    // Merge unique tracks.
    const existingIds = new Set(tracks.map((t) => t.id));
    const merged = [
        ...tracks,
        ...genreMatched.filter((t) => !existingIds.has(t.id)),
    ];

    return merged.slice(0, limit) as TrackWithAlbumCover[];
}

/**
 * Represents the ProgrammaticPlaylistService class.
 */
export class ProgrammaticPlaylistServiceBase {
    protected readonly TRACK_LIMIT = 20;
    protected readonly DAILY_MIX_COUNT = 5;
    protected readonly MAX_TRACKS_PER_ARTIST = 2;
    protected readonly MAX_RELAXED_TRACKS_PER_ARTIST = 4;
    protected readonly ARTIST_SIMILAR_FETCH_LIMIT = 20;

    protected trackWhere(
        where: Prisma.TrackWhereInput | undefined = {},
    ): Prisma.TrackWhereInput {
        const { AND: inputAnd, ...input } = where ?? {};
        const inputClauses = Array.isArray(inputAnd)
            ? inputAnd
            : inputAnd
              ? [inputAnd]
              : [];
        return {
            ...input,
            ...TRACK_VISIBLE_WHERE,
            AND: [...inputClauses, ...(TRACK_BROWSE_WHERE.AND ?? [])],
        };
    }

    // Track count thresholds for mix generation
    protected readonly MIN_TRACKS_DAILY = 8; // Minimum to generate a daily mix
    protected readonly MIN_TRACKS_WEEKLY = 15; // Minimum to generate a weekly mix
    protected readonly DAILY_TRACK_LIMIT = 10; // Daily mix size
    protected readonly WEEKLY_TRACK_LIMIT = 20; // Weekly mix size

    protected diversifyTracks<T extends ArtistCapTrack>(
        tracks: T[],
        targetCount: number,
        seedKey: string,
        preserveInputOrder = false,
    ): T[] {
        return separateArtists(
            applyArtistCap(tracks, {
                maxPerArtist: this.MAX_TRACKS_PER_ARTIST,
                targetCount,
                preserveInputOrder,
                rng: createSeededRng(getSeededRandom(seedKey)),
                fallback: {
                    enabled: true,
                    maxRelaxedPerArtist: this.MAX_RELAXED_TRACKS_PER_ARTIST,
                    refillFromExcludedAfterMaxRelaxation: true,
                },
            }),
            (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
        );
    }

    protected diversifyTracksUniqueFirst<T extends ArtistCapTrack>(
        tracks: T[],
        targetCount: number,
        seedKey: string,
    ): T[] {
        const firstPass = applyArtistCap(tracks, {
            maxPerArtist: 1,
            targetCount,
            rng: createSeededRng(getSeededRandom(`${seedKey}-first-pass`)),
            fallback: { enabled: false },
        });

        if (firstPass.length >= targetCount) {
            return separateArtists(
                firstPass,
                (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
            );
        }

        const selectedIds = new Set(firstPass.map((track) => track.id));
        const remainingTracks = seededShuffle(
            tracks.filter((track) => !selectedIds.has(track.id)),
            `${seedKey}-second-pass`,
        );

        return separateArtists(
            applyArtistCap([...firstPass, ...remainingTracks], {
                maxPerArtist: this.MAX_TRACKS_PER_ARTIST,
                targetCount,
                preserveInputOrder: true,
                fallback: { enabled: false },
            }),
            (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
        );
    }

    protected getUniqueArtistCount<T extends ArtistCapTrack>(
        tracks: T[],
    ): number {
        const uniqueArtists = new Set<string>();
        for (const track of tracks) {
            const artistId = track.album?.artist?.id;
            if (typeof artistId === "string" && artistId.trim().length > 0) {
                uniqueArtists.add(artistId);
            }
        }
        return uniqueArtists.size;
    }

    protected async backfillFromLibraryForDiversity<
        T extends TrackWithAlbumCover,
    >(selectedTracks: T[], targetCount: number, seedKey: string): Promise<T[]> {
        const minimumUniqueArtists = Math.ceil(targetCount * 0.55);
        const uniqueArtistCount = this.getUniqueArtistCount(selectedTracks);

        if (
            selectedTracks.length >= targetCount &&
            uniqueArtistCount >= minimumUniqueArtists
        ) {
            return separateArtists(
                selectedTracks,
                (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
            );
        }

        logger.debug(
            `[DIVERSITY BACKFILL] ${seedKey} needs backfill (${selectedTracks.length}/${targetCount}, unique=${uniqueArtistCount}/${minimumUniqueArtists})`,
        );

        const selectedIds = new Set(selectedTracks.map((track) => track.id));
        const fallbackTracks = (await prisma.track.findMany({
            where: this.trackWhere({ id: { notIn: Array.from(selectedIds) } }),
            include: {
                album: {
                    select: {
                        coverUrl: true,
                        artist: { select: { id: true } },
                    },
                },
            },
            orderBy: { id: "asc" },
            take: targetCount * 50,
        })) as unknown as T[];

        const shuffledFallback = seededShuffle(
            fallbackTracks,
            `${seedKey}-library-diversity-backfill`,
        );

        const needsUniqueRebalance =
            selectedTracks.length >= targetCount &&
            uniqueArtistCount < minimumUniqueArtists;

        return separateArtists(
            applyArtistCap([...selectedTracks, ...shuffledFallback], {
                maxPerArtist: this.MAX_TRACKS_PER_ARTIST,
                targetCount,
                preserveInputOrder: !needsUniqueRebalance,
                rng: createSeededRng(
                    getSeededRandom(`${seedKey}-library-rebalance`),
                ),
                fallback: { enabled: false },
            }),
            (t) => t.album?.artist?.id ?? `unknown:${t.id}`,
        );
    }
}
