import { addMonths, endOfWeek, startOfWeek, subDays, subWeeks } from "date-fns";
import { prisma } from "../../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { logger } from "../../utils/logger";
import { discoverySeeding } from "./discoverySeeding";
import {
    applyTrackPreferenceSimilarityBias,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../trackPreference";
import { separateArtists } from "../../utils/separateArtists";
import { applyArtistCap } from "../programmaticPlaylistArtistCap";

/**
 * Weekly score multiplier for recently featured artists so fresh candidates
 * outrank repeats without removing repeat artists from the candidate pool.
 */
const RECENT_FEATURE_DECAY = 0.6;

/**
 * Cap the six-week repeat penalty at three featured weeks; 3+ appearances
 * receive about 0.22x, below the generic candidate score of 0.35.
 */
const RECENT_FEATURE_DECAY_MAX_WEEKS = 3;

type RecommendationTier = "high" | "medium" | "explore" | "wildcard";

interface SelectedTrack {
    trackId: string;
    title: string;
    duration: number;
    filePath: string;
    albumId: string;
    albumTitle: string;
    albumMbid: string;
    artistId: string;
    artistName: string;
    artistMbid: string;
    coverUrl: string | null;
    similarity: number;
    tier: RecommendationTier;
}

interface GenerateResult {
    success: boolean;
    playlistName: string;
    songCount: number;
    batchId?: string;
}

interface CurrentPlaylistTrack {
    id: string;
    title: string;
    artist: string;
    album: string;
    albumId: string;
    isLiked: boolean;
    likedAt: Date | null;
    similarity: number;
    tier: RecommendationTier;
    coverUrl: string | null;
    available: boolean;
    duration: number;
    sourceType: "local";
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
}

interface CurrentPlaylistResponse {
    weekStart: Date;
    weekEnd: Date;
    tracks: CurrentPlaylistTrack[];
    unavailable: never[];
    totalCount: number;
    unavailableCount: number;
}

type ArtistIdentity = {
    mbid?: string | null;
    name?: string | null;
};

type ResolvedArtistIdentity = {
    id: string;
    mbid: string;
    name: string;
};

type RecentFeaturedArtist = {
    artistMbid: string | null;
    artistName: string;
    weekStartDate: Date;
};

type SelectableDiscoveryTrack = {
    id: string;
    title: string;
    duration: number;
    filePath: string | null;
    albumId: string;
    album: {
        artistId: string;
        title: string;
        rgMbid: string;
        coverUrl: string | null;
        artist: {
            id: string;
            name: string;
            mbid: string;
        };
    };
};

type ScoredDiscoveryTrack = SelectableDiscoveryTrack & {
    score: number;
    tier: RecommendationTier;
};

/** Build the MBID/name OR clauses used to resolve library artists. */
function buildArtistIdentityClauses(
    identities: ArtistIdentity[],
): Array<Record<string, unknown>> {
    const mbids = Array.from(
        new Set(
            identities
                .map((identity) => identity.mbid)
                .filter((mbid): mbid is string => Boolean(mbid)),
        ),
    );
    const namesByLowercase = new Map<string, string>();
    for (const identity of identities) {
        if (!identity.name) continue;
        const lowercaseName = identity.name.toLowerCase();
        if (!namesByLowercase.has(lowercaseName)) {
            namesByLowercase.set(lowercaseName, identity.name);
        }
    }
    const names = Array.from(namesByLowercase.values());
    const clauses: Array<Record<string, unknown>> = [];
    if (mbids.length > 0) clauses.push({ mbid: { in: mbids } });
    for (const name of names) {
        clauses.push({
            name: { equals: name, mode: "insensitive" as const },
        });
    }
    return clauses;
}

/** Return whether a stored feature row identifies a resolved artist. */
function featureMatchesArtist(
    feature: RecentFeaturedArtist,
    artist: ResolvedArtistIdentity,
): boolean {
    if (feature.artistMbid && artist.mbid) {
        return feature.artistMbid === artist.mbid;
    }
    return (
        feature.artistName.localeCompare(artist.name, undefined, {
            sensitivity: "accent",
        }) === 0
    );
}

/** Count distinct featured weeks for a resolved artist. */
function countFeaturedWeeks(
    features: RecentFeaturedArtist[],
    artist: ResolvedArtistIdentity,
): number {
    const weeks = new Set<number>();
    for (const feature of features) {
        if (featureMatchesArtist(feature, artist)) {
            weeks.add(feature.weekStartDate.getTime());
        }
    }
    return weeks.size;
}

/** Keep the first, highest-ranked track for each album. */
function dedupeTracksByAlbum<T extends { albumId: string }>(tracks: T[]): T[] {
    const seenAlbumIds = new Set<string>();
    const deduped: T[] = [];
    for (const track of tracks) {
        if (seenAlbumIds.has(track.albumId)) continue;
        seenAlbumIds.add(track.albumId);
        deduped.push(track);
    }
    return deduped;
}

/** Map a selected library track into the persisted Discover Weekly shape. */
function toSelectedTrack(
    track: SelectableDiscoveryTrack,
    similarity: number,
    tier: RecommendationTier,
): SelectedTrack {
    return {
        trackId: track.id,
        title: track.title,
        duration: track.duration,
        filePath: track.filePath ?? "",
        albumId: track.albumId,
        albumTitle: track.album.title,
        albumMbid: track.album.rgMbid,
        artistId: track.album.artist.id,
        artistName: track.album.artist.name,
        artistMbid: track.album.artist.mbid,
        coverUrl: track.album.coverUrl,
        similarity,
        tier,
    };
}

/** Score candidate tracks while preserving all fields needed for selection. */
function scoreDiscoveryCandidates(
    tracks: SelectableDiscoveryTrack[],
    artistScores: Map<string, number>,
    preferenceScores: Map<string, number>,
): ScoredDiscoveryTrack[] {
    return tracks
        .map((track) => {
            const artistScore = artistScores.get(track.album.artistId) ?? 0.35;
            const baseScore = clampSimilarity(artistScore + randomJitter(0.14));
            const score = clampSimilarity(
                applyTrackPreferenceSimilarityBias(
                    baseScore,
                    preferenceScores.get(track.id) ?? 0,
                ),
            );
            return { ...track, score, tier: similarityToTier(score) };
        })
        .sort((left, right) => right.score - left.score);
}

/** Apply the shared strict/relaxed cap to a ranked discovery pass. */
function capRankedDiscoveryTracks<T extends SelectableDiscoveryTrack>(
    tracks: T[],
    targetCount: number,
    strictArtistCap: number,
    relaxedArtistCap: number,
    alreadySelected?: T[],
): T[] {
    return applyArtistCap(dedupeTracksByAlbum(tracks), {
        preserveInputOrder: true,
        targetCount,
        maxPerArtist: strictArtistCap,
        ...(alreadySelected ? { alreadySelected } : {}),
        fallback: {
            enabled: true,
            relaxationStep: Math.max(1, relaxedArtistCap - strictArtistCap),
            maxRelaxedPerArtist: relaxedArtistCap,
        },
    });
}

/** Score and map fallback tracks after rank-preserving artist selection. */
function mapFallbackSelections(
    tracks: SelectableDiscoveryTrack[],
    preferenceScores: Map<string, number>,
): SelectedTrack[] {
    return tracks.map((track) => {
        const similarity = clampSimilarity(
            applyTrackPreferenceSimilarityBias(
                0.34 + randomJitter(0.15),
                preferenceScores.get(track.id) ?? 0,
            ),
        );
        return toSelectedTrack(track, similarity, similarityToTier(similarity));
    });
}

function clampSimilarity(value: number): number {
    if (!Number.isFinite(value)) return 0.35;
    return Math.max(0.15, Math.min(0.99, value));
}

function similarityToTier(similarity: number): RecommendationTier {
    if (similarity >= 0.7) return "high";
    if (similarity >= 0.5) return "medium";
    if (similarity >= 0.3) return "explore";
    return "wildcard";
}

function randomJitter(max = 0.12): number {
    return Math.random() * max;
}

function getArtistCapForTarget(targetCount: number): number {
    if (!Number.isFinite(targetCount) || targetCount <= 0) return 2;
    return Math.max(2, Math.floor(targetCount / 10));
}

function getRelaxedArtistCapForTarget(targetCount: number): number {
    const strictCap = getArtistCapForTarget(targetCount);
    return Math.max(strictCap + 1, Math.ceil(targetCount / 6));
}

/**
 * Represents the DiscoveryRecommendationsService class.
 */
export class DiscoveryRecommendationsService {
    private async getOrCreateUserConfig(userId: string) {
        const existing = await prisma.userDiscoverConfig.findUnique({
            where: { userId },
        });

        if (existing) {
            return existing;
        }

        return prisma.userDiscoverConfig.create({
            data: {
                userId,
                playlistSize: 10,
                maxRetryAttempts: 3,
                exclusionMonths: 6,
                downloadRatio: 1.3,
                enabled: true,
            },
        });
    }

    private async resolveSeedArtistIds(userId: string): Promise<string[]> {
        const seeds = await discoverySeeding.getSeedArtists(userId);
        const whereClauses = buildArtistIdentityClauses(seeds);

        if (whereClauses.length === 0) {
            return [];
        }

        const artists = await prisma.artist.findMany({
            where: {
                OR: whereClauses,
            },
            select: { id: true },
            take: 30,
        });

        return artists.map((artist) => artist.id);
    }

    private async applyRecentArtistDecay(
        userId: string,
        scoreMap: Map<string, number>,
    ): Promise<void> {
        const currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const recentFeatures = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: {
                    lt: currentWeekStart,
                    gte: subWeeks(currentWeekStart, 6),
                },
            },
            select: {
                artistMbid: true,
                artistName: true,
                weekStartDate: true,
            },
            // Bounds six weeks x 50 tracks x both discovery pipelines.
            take: 600,
        });
        if (recentFeatures.length === 0) return;

        const whereClauses = buildArtistIdentityClauses(
            recentFeatures.map((feature) => ({
                mbid: feature.artistMbid,
                name: feature.artistName,
            })),
        );
        if (whereClauses.length === 0) return;

        const artists = await prisma.artist.findMany({
            where: { OR: whereClauses },
            select: { id: true, mbid: true, name: true },
        });
        for (const artist of artists) {
            const score = scoreMap.get(artist.id);
            if (score === undefined) continue;
            const weeks = Math.min(
                countFeaturedWeeks(recentFeatures, artist),
                RECENT_FEATURE_DECAY_MAX_WEEKS,
            );
            if (weeks === 0) continue;
            scoreMap.set(
                artist.id,
                score * Math.pow(RECENT_FEATURE_DECAY, weeks),
            );
        }
    }

    private async addSeedArtistScores(
        userId: string,
        scoreMap: Map<string, number>,
    ): Promise<void> {
        const seedArtistIds = await this.resolveSeedArtistIds(userId);
        for (const artistId of seedArtistIds) {
            scoreMap.set(artistId, 0.62 + randomJitter(0.08));
        }
        if (seedArtistIds.length === 0) return;

        const similarEdges = await prisma.similarArtist.findMany({
            where: { fromArtistId: { in: seedArtistIds } },
            orderBy: { weight: "desc" },
            select: { toArtistId: true, weight: true },
            take: 800,
        });
        for (const edge of similarEdges) {
            const weighted = clampSimilarity(edge.weight || 0.35);
            const existing = scoreMap.get(edge.toArtistId) || 0;
            if (weighted > existing) {
                scoreMap.set(edge.toArtistId, weighted);
            }
        }
    }

    private async addRecentPlayArtistScores(
        userId: string,
        scoreMap: Map<string, number>,
    ): Promise<void> {
        if (scoreMap.size > 0) return;

        const recentPlays = await prisma.play.findMany({
            where: {
                userId,
                playedAt: { gte: subDays(new Date(), 120) },
                track: {
                    ...TRACK_VISIBLE_WHERE,
                    ...TRACK_BROWSE_WHERE,
                },
            },
            select: {
                track: {
                    select: {
                        album: { select: { artistId: true } },
                    },
                },
            },
            take: 600,
            orderBy: { playedAt: "desc" },
        });
        for (const play of recentPlays) {
            const artistId = play.track?.album?.artistId;
            if (artistId && !scoreMap.has(artistId)) {
                scoreMap.set(artistId, 0.5 + randomJitter(0.08));
            }
        }
    }

    private async addCatalogArtistScores(
        scoreMap: Map<string, number>,
    ): Promise<void> {
        if (scoreMap.size > 0) return;

        const fallbackArtists = await prisma.artist.findMany({
            where: {
                albums: {
                    some: {
                        tracks: { some: {} },
                    },
                },
            },
            select: { id: true },
            take: 100,
            orderBy: { countsLastUpdated: "desc" },
        });
        for (const artist of fallbackArtists) {
            scoreMap.set(artist.id, 0.4 + randomJitter(0.08));
        }
    }

    private async buildArtistScoreMap(
        userId: string,
    ): Promise<Map<string, number>> {
        const scoreMap = new Map<string, number>();
        await this.addSeedArtistScores(userId, scoreMap);
        await this.addRecentPlayArtistScores(userId, scoreMap);
        await this.addCatalogArtistScores(scoreMap);

        await this.applyRecentArtistDecay(userId, scoreMap);
        return scoreMap;
    }

    private async getTrackPreferenceScoreMap(
        userId: string,
        trackIds: string[],
    ): Promise<Map<string, number>> {
        if (trackIds.length === 0) {
            return new Map<string, number>();
        }

        const uniqueTrackIds = Array.from(new Set(trackIds));

        const [likedEntries, dislikedEntries] = await Promise.all([
            prisma.likedTrack.findMany({
                where: {
                    userId,
                    trackId: { in: uniqueTrackIds },
                },
                select: {
                    trackId: true,
                    likedAt: true,
                },
            }),
            prisma.dislikedEntity.findMany({
                where: {
                    userId,
                    entityType: TRACK_DISLIKE_ENTITY_TYPE,
                    entityId: { in: uniqueTrackIds },
                },
                select: {
                    entityId: true,
                    dislikedAt: true,
                },
            }),
        ]);

        const likedByTrackId = new Map<string, Date>();
        for (const entry of likedEntries) {
            likedByTrackId.set(entry.trackId, entry.likedAt);
        }

        const dislikedByTrackId = new Map<string, Date>();
        for (const entry of dislikedEntries) {
            dislikedByTrackId.set(entry.entityId, entry.dislikedAt);
        }

        const scoreMap = new Map<string, number>();
        for (const trackId of uniqueTrackIds) {
            const resolved = resolveTrackPreference({
                likedAt: likedByTrackId.get(trackId) ?? null,
                dislikedAt: dislikedByTrackId.get(trackId) ?? null,
            });
            if (resolved.score !== 0) {
                scoreMap.set(trackId, resolved.score);
            }
        }

        return scoreMap;
    }

    private async getSelectionFilters(userId: string): Promise<{
        recentTrackIds: string[];
        excludedAlbumMbids: string[];
    }> {
        const recentPlays = await prisma.play.findMany({
            where: {
                userId,
                playedAt: { gte: subDays(new Date(), 14) },
            },
            select: { trackId: true },
            take: 5000,
        });
        const recentTrackIds = recentPlays
            .map((play) => play.trackId)
            .filter(
                (trackId): trackId is string => typeof trackId === "string",
            );
        const activeExclusions = await prisma.discoverExclusion.findMany({
            where: { userId, expiresAt: { gt: new Date() } },
            select: { albumMbid: true },
        });
        return {
            recentTrackIds,
            excludedAlbumMbids: activeExclusions.map(
                (entry) => entry.albumMbid,
            ),
        };
    }

    private async findPrimaryCandidateTracks(
        targetCount: number,
        prioritizedArtistIds: string[],
        recentTrackIds: string[],
        excludedAlbumMbids: string[],
    ): Promise<SelectableDiscoveryTrack[]> {
        return prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                duration: { gt: 0 },
                ...(recentTrackIds.length > 0
                    ? { id: { notIn: recentTrackIds } }
                    : {}),
                album: {
                    location: { in: ["LIBRARY", "FEDERATED"] },
                    ...(prioritizedArtistIds.length > 0
                        ? { artistId: { in: prioritizedArtistIds } }
                        : {}),
                    ...(excludedAlbumMbids.length > 0
                        ? { rgMbid: { notIn: excludedAlbumMbids } }
                        : {}),
                },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: { id: true, name: true, mbid: true },
                        },
                    },
                },
            },
            take: Math.max(targetCount * 20, 220),
            orderBy: [{ updatedAt: "desc" }],
        });
    }

    private async findFallbackCandidateTracks(
        targetCount: number,
        selectedTrackIds: string[],
        excludedAlbumMbids: string[],
    ): Promise<SelectableDiscoveryTrack[]> {
        return prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                duration: { gt: 0 },
                id: { notIn: selectedTrackIds },
                album: {
                    location: { in: ["LIBRARY", "FEDERATED"] },
                    ...(excludedAlbumMbids.length > 0
                        ? { rgMbid: { notIn: excludedAlbumMbids } }
                        : {}),
                },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: { id: true, name: true, mbid: true },
                        },
                    },
                },
            },
            take: Math.max(targetCount * 10, 180),
            orderBy: [{ updatedAt: "desc" }],
        });
    }

    private async selectFallbackTracks(
        userId: string,
        targetCount: number,
        strictArtistCap: number,
        relaxedArtistCap: number,
        primaryTracks: ScoredDiscoveryTrack[],
        excludedAlbumMbids: string[],
    ): Promise<SelectedTrack[]> {
        const selectedTrackIds = primaryTracks.map((track) => track.id);
        const selectedTrackIdSet = new Set(selectedTrackIds);
        const selectedAlbumIds = new Set(
            primaryTracks.map((track) => track.albumId),
        );
        const fallbackTracks = await this.findFallbackCandidateTracks(
            targetCount,
            selectedTrackIds,
            excludedAlbumMbids,
        );
        const preferenceScores = await this.getTrackPreferenceScoreMap(
            userId,
            fallbackTracks.map((track) => track.id),
        );
        const eligibleTracks = fallbackTracks.filter(
            (track) =>
                !selectedTrackIdSet.has(track.id) &&
                !selectedAlbumIds.has(track.albumId),
        );
        const selections = capRankedDiscoveryTracks(
            eligibleTracks,
            targetCount - primaryTracks.length,
            strictArtistCap,
            relaxedArtistCap,
            primaryTracks,
        );
        return mapFallbackSelections(selections, preferenceScores);
    }

    private async selectTracks(
        userId: string,
        targetCount: number,
    ): Promise<SelectedTrack[]> {
        const strictArtistCap = getArtistCapForTarget(targetCount);
        const relaxedArtistCap = getRelaxedArtistCapForTarget(targetCount);
        const artistScores = await this.buildArtistScoreMap(userId);
        const prioritizedArtistIds = Array.from(artistScores.keys());
        const { recentTrackIds, excludedAlbumMbids } =
            await this.getSelectionFilters(userId);
        const candidateTracks = await this.findPrimaryCandidateTracks(
            targetCount,
            prioritizedArtistIds,
            recentTrackIds,
            excludedAlbumMbids,
        );
        const preferenceScores = await this.getTrackPreferenceScoreMap(
            userId,
            candidateTracks.map((track) => track.id),
        );
        const scoredCandidates = scoreDiscoveryCandidates(
            candidateTracks,
            artistScores,
            preferenceScores,
        );
        const primaryTracks = capRankedDiscoveryTracks(
            scoredCandidates,
            targetCount,
            strictArtistCap,
            relaxedArtistCap,
        );
        const selected = primaryTracks.map((track) =>
            toSelectedTrack(track, track.score, track.tier),
        );

        if (selected.length < targetCount) {
            const fallbackSelections = await this.selectFallbackTracks(
                userId,
                targetCount,
                strictArtistCap,
                relaxedArtistCap,
                primaryTracks,
                excludedAlbumMbids,
            );
            selected.push(...fallbackSelections);
        }

        return separateArtists(
            selected.slice(0, targetCount),
            (t) => t.artistId,
        );
    }

    async generatePlaylist(userId: string): Promise<GenerateResult> {
        const userConfig = await this.getOrCreateUserConfig(userId);

        if (!userConfig.enabled) {
            throw new Error("Discovery Weekly not enabled");
        }

        const targetCount = Math.max(
            5,
            Math.min(50, userConfig.playlistSize || 10),
        );
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 });
        const selectedTracks = await this.selectTracks(userId, targetCount);
        const now = new Date();

        await prisma.$transaction(async (tx) => {
            const existing = await tx.discoveryAlbum.findMany({
                where: {
                    userId,
                    weekStartDate: weekStart,
                },
                select: { id: true },
            });
            const existingIds = existing.map((album) => album.id);

            if (existingIds.length > 0) {
                await tx.discoveryTrack.deleteMany({
                    where: {
                        discoveryAlbumId: { in: existingIds },
                    },
                });
                await tx.discoveryAlbum.deleteMany({
                    where: {
                        id: { in: existingIds },
                    },
                });
            }

            await tx.unavailableAlbum.deleteMany({
                where: {
                    userId,
                    weekStartDate: weekStart,
                },
            });

            for (const item of selectedTracks) {
                const discoveryAlbum = await tx.discoveryAlbum.create({
                    data: {
                        userId,
                        catalogAlbumId: item.albumId,
                        rgMbid: item.albumMbid,
                        artistName: item.artistName,
                        artistMbid: item.artistMbid,
                        albumTitle: item.albumTitle,
                        weekStartDate: weekStart,
                        weekEndDate: weekEnd,
                        status: "ACTIVE",
                        downloadedAt: now,
                        folderPath: "",
                        similarity: item.similarity,
                        tier: item.tier,
                    },
                });

                await tx.discoveryTrack.create({
                    data: {
                        discoveryAlbumId: discoveryAlbum.id,
                        trackId: item.trackId,
                        fileName: item.title,
                        filePath: item.filePath,
                        inPlaylistCount: 1,
                        userKept: false,
                    },
                });

                if (userConfig.exclusionMonths > 0) {
                    const expiresAt = addMonths(
                        now,
                        userConfig.exclusionMonths,
                    );
                    await tx.discoverExclusion.upsert({
                        where: {
                            userId_albumMbid: {
                                userId,
                                albumMbid: item.albumMbid,
                            },
                        },
                        create: {
                            userId,
                            albumMbid: item.albumMbid,
                            artistName: item.artistName,
                            albumTitle: item.albumTitle,
                            lastSuggestedAt: now,
                            expiresAt,
                        },
                        update: {
                            artistName: item.artistName,
                            albumTitle: item.albumTitle,
                            lastSuggestedAt: now,
                            expiresAt,
                        },
                    });
                }
            }

            await tx.userDiscoverConfig.update({
                where: { userId },
                data: { lastGeneratedAt: now },
            });
        });

        logger.info(
            `[DiscoveryRecommendations] Generated ${selectedTracks.length} recommendation tracks for user ${userId}`,
        );

        return {
            success: true,
            playlistName: `Discover Weekly (Week of ${weekStart.toLocaleDateString()})`,
            songCount: selectedTracks.length,
        };
    }

    async getCurrentPlaylist(userId: string): Promise<CurrentPlaylistResponse> {
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 });

        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
                status: { in: ["ACTIVE", "LIKED"] },
            },
            include: {
                tracks: true,
            },
            orderBy: { downloadedAt: "asc" },
        });

        const trackIds = discoveryAlbums
            .flatMap((album) => album.tracks)
            .map((track) => track.trackId)
            .filter((trackId): trackId is string => Boolean(trackId));

        const libraryTracks = trackIds.length
            ? await prisma.track.findMany({
                  where: {
                      ...TRACK_VISIBLE_WHERE,
                      ...TRACK_BROWSE_WHERE,
                      id: { in: trackIds },
                  },
                  include: {
                      album: {
                          include: {
                              artist: true,
                          },
                      },
                  },
              })
            : [];

        const trackById = new Map(
            libraryTracks.map((track) => [track.id, track]),
        );

        const tracks: CurrentPlaylistTrack[] = [];

        for (const discoveryAlbum of discoveryAlbums) {
            for (const discoveryTrack of discoveryAlbum.tracks) {
                if (!discoveryTrack.trackId) continue;
                const track = trackById.get(discoveryTrack.trackId);
                if (!track) continue;

                const similarity = clampSimilarity(
                    discoveryAlbum.similarity ?? 0.35,
                );
                const tier =
                    (discoveryAlbum.tier as RecommendationTier | null) ||
                    similarityToTier(similarity);

                tracks.push({
                    id: track.id,
                    title: track.title,
                    artist: track.album.artist.name,
                    album: track.album.title,
                    albumId: discoveryAlbum.rgMbid,
                    isLiked: false,
                    likedAt: null,
                    similarity,
                    tier,
                    coverUrl: track.album.coverUrl,
                    available: true,
                    duration: track.duration,
                    sourceType: "local",
                    loudnessLufs: track.loudnessLufs,
                    truePeakDb: track.truePeakDb,
                    albumLoudnessLufs: track.album.albumLoudnessLufs,
                    albumTruePeakDb: track.album.albumTruePeakDb,
                });
            }
        }

        return {
            weekStart,
            weekEnd,
            tracks,
            unavailable: [],
            totalCount: tracks.length,
            unavailableCount: 0,
        };
    }

    async clearCurrentPlaylist(
        userId: string,
    ): Promise<{ clearedCount: number }> {
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

        const existing = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
                status: { in: ["ACTIVE", "LIKED"] },
            },
            select: { id: true },
        });
        const existingIds = existing.map((album) => album.id);

        if (existingIds.length > 0) {
            await prisma.discoveryTrack.deleteMany({
                where: { discoveryAlbumId: { in: existingIds } },
            });
            await prisma.discoveryAlbum.deleteMany({
                where: { id: { in: existingIds } },
            });
        }

        await prisma.unavailableAlbum.deleteMany({
            where: {
                userId,
                weekStartDate: weekStart,
            },
        });

        return { clearedCount: existingIds.length };
    }
}

export const discoveryRecommendationsService =
    new DiscoveryRecommendationsService();
