import { addMonths, endOfWeek, startOfWeek, subDays } from "date-fns";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { discoverySeeding } from "./discoverySeeding";
import {
    applyTrackPreferenceSimilarityBias,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../trackPreference";

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
}

interface CurrentPlaylistResponse {
    weekStart: Date;
    weekEnd: Date;
    tracks: CurrentPlaylistTrack[];
    unavailable: never[];
    totalCount: number;
    unavailableCount: number;
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

        const mbids = seeds.map((seed) => seed.mbid).filter(Boolean) as string[];
        const names = seeds.map((seed) => seed.name).filter(Boolean);

        const whereClauses: Array<Record<string, unknown>> = [];
        if (mbids.length > 0) {
            whereClauses.push({ mbid: { in: mbids } });
        }
        if (names.length > 0) {
            whereClauses.push(
                ...names.map((name) => ({
                    name: {
                        equals: name,
                        mode: "insensitive" as const,
                    },
                }))
            );
        }

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

    private async buildArtistScoreMap(
        userId: string
    ): Promise<Map<string, number>> {
        const scoreMap = new Map<string, number>();

        const seedArtistIds = await this.resolveSeedArtistIds(userId);
        for (const artistId of seedArtistIds) {
            scoreMap.set(artistId, 0.62 + randomJitter(0.08));
        }

        if (seedArtistIds.length > 0) {
            const similarEdges = await prisma.similarArtist.findMany({
                where: {
                    fromArtistId: { in: seedArtistIds },
                },
                orderBy: { weight: "desc" },
                select: {
                    toArtistId: true,
                    weight: true,
                },
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

        if (scoreMap.size === 0) {
            // Fallback: derive seeds from recent plays when metadata seeding is unavailable.
            const recentPlays = await prisma.play.findMany({
                where: {
                    userId,
                    playedAt: { gte: subDays(new Date(), 120) },
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

            for (const play of recentPlays) {
                const artistId = play.track?.album?.artistId;
                if (!artistId) continue;
                if (!scoreMap.has(artistId)) {
                    scoreMap.set(artistId, 0.5 + randomJitter(0.08));
                }
            }
        }

        if (scoreMap.size === 0) {
            // Last resort fallback for very fresh libraries.
            const fallbackArtists = await prisma.artist.findMany({
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

            for (const artist of fallbackArtists) {
                scoreMap.set(artist.id, 0.4 + randomJitter(0.08));
            }
        }

        return scoreMap;
    }

    private async getTrackPreferenceScoreMap(
        userId: string,
        trackIds: string[]
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

    private async selectTracks(
        userId: string,
        targetCount: number
    ): Promise<SelectedTrack[]> {
        const strictArtistCap = getArtistCapForTarget(targetCount);
        const relaxedArtistCap = getRelaxedArtistCapForTarget(targetCount);
        const artistScores = await this.buildArtistScoreMap(userId);
        const prioritizedArtistIds = Array.from(artistScores.keys());

        const recentPlays = await prisma.play.findMany({
            where: {
                userId,
                playedAt: { gte: subDays(new Date(), 14) },
            },
            select: { trackId: true },
            take: 5000,
        });
        const recentTrackIds = recentPlays.map((play) => play.trackId);

        const activeExclusions = await prisma.discoverExclusion.findMany({
            where: {
                userId,
                expiresAt: { gt: new Date() },
            },
            select: { albumMbid: true },
        });
        const excludedAlbumMbids = activeExclusions.map((entry) => entry.albumMbid);

        const candidateTracks = await prisma.track.findMany({
            where: {
                duration: { gt: 0 },
                ...(recentTrackIds.length > 0
                    ? { id: { notIn: recentTrackIds } }
                    : {}),
                album: {
                    location: "LIBRARY",
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
                            select: {
                                id: true,
                                name: true,
                                mbid: true,
                            },
                        },
                    },
                },
            },
            take: Math.max(targetCount * 20, 220),
            orderBy: [{ updatedAt: "desc" }],
        });
        const candidatePreferenceScores = await this.getTrackPreferenceScoreMap(
            userId,
            candidateTracks.map((track) => track.id)
        );

        const scoredCandidates = candidateTracks
            .map((track) => {
                const artistScore = artistScores.get(track.album.artistId) ?? 0.35;
                const baseScore = clampSimilarity(artistScore + randomJitter(0.14));
                const score = clampSimilarity(
                    applyTrackPreferenceSimilarityBias(
                        baseScore,
                        candidatePreferenceScores.get(track.id) ?? 0
                    )
                );
                return {
                    track,
                    score,
                    tier: similarityToTier(score),
                };
            })
            .sort((left, right) => right.score - left.score);

        const selected: SelectedTrack[] = [];
        const selectedAlbumIds = new Set<string>();
        const selectedTrackIds = new Set<string>();
        const selectedArtistCounts = new Map<string, number>();

        const canSelectArtist = (artistId: string, cap: number): boolean =>
            (selectedArtistCounts.get(artistId) ?? 0) < cap;

        const recordSelectedArtist = (artistId: string): void => {
            selectedArtistCounts.set(artistId, (selectedArtistCounts.get(artistId) ?? 0) + 1);
        };

        const deferredPrimaryCandidates: typeof scoredCandidates = [];

        for (const candidate of scoredCandidates) {
            if (selected.length >= targetCount) break;
            if (selectedTrackIds.has(candidate.track.id)) continue;
            if (selectedAlbumIds.has(candidate.track.albumId)) continue;
            if (!canSelectArtist(candidate.track.album.artist.id, strictArtistCap)) {
                deferredPrimaryCandidates.push(candidate);
                continue;
            }

            selectedTrackIds.add(candidate.track.id);
            selectedAlbumIds.add(candidate.track.albumId);
            recordSelectedArtist(candidate.track.album.artist.id);

            selected.push({
                trackId: candidate.track.id,
                title: candidate.track.title,
                duration: candidate.track.duration,
                filePath: candidate.track.filePath,
                albumId: candidate.track.albumId,
                albumTitle: candidate.track.album.title,
                albumMbid: candidate.track.album.rgMbid,
                artistId: candidate.track.album.artist.id,
                artistName: candidate.track.album.artist.name,
                artistMbid: candidate.track.album.artist.mbid,
                coverUrl: candidate.track.album.coverUrl,
                similarity: candidate.score,
                tier: candidate.tier,
            });
        }

        if (selected.length < targetCount) {
            for (const candidate of deferredPrimaryCandidates) {
                if (selected.length >= targetCount) break;
                if (selectedTrackIds.has(candidate.track.id)) continue;
                if (selectedAlbumIds.has(candidate.track.albumId)) continue;
                if (
                    !canSelectArtist(
                        candidate.track.album.artist.id,
                        relaxedArtistCap
                    )
                ) {
                    continue;
                }

                selectedTrackIds.add(candidate.track.id);
                selectedAlbumIds.add(candidate.track.albumId);
                recordSelectedArtist(candidate.track.album.artist.id);

                selected.push({
                    trackId: candidate.track.id,
                    title: candidate.track.title,
                    duration: candidate.track.duration,
                    filePath: candidate.track.filePath,
                    albumId: candidate.track.albumId,
                    albumTitle: candidate.track.album.title,
                    albumMbid: candidate.track.album.rgMbid,
                    artistId: candidate.track.album.artist.id,
                    artistName: candidate.track.album.artist.name,
                    artistMbid: candidate.track.album.artist.mbid,
                    coverUrl: candidate.track.album.coverUrl,
                    similarity: candidate.score,
                    tier: candidate.tier,
                });
            }
        }

        if (selected.length < targetCount) {
            const fallbackTracks = await prisma.track.findMany({
                where: {
                    duration: { gt: 0 },
                    id: { notIn: Array.from(selectedTrackIds) },
                    album: {
                        location: "LIBRARY",
                        ...(excludedAlbumMbids.length > 0
                            ? { rgMbid: { notIn: excludedAlbumMbids } }
                            : {}),
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
                take: Math.max(targetCount * 10, 180),
                orderBy: [{ updatedAt: "desc" }],
            });
            const fallbackPreferenceScores = await this.getTrackPreferenceScoreMap(
                userId,
                fallbackTracks.map((track) => track.id)
            );

            const deferredFallbackTracks: typeof fallbackTracks = [];

            for (const track of fallbackTracks) {
                if (selected.length >= targetCount) break;
                if (selectedTrackIds.has(track.id)) continue;
                if (selectedAlbumIds.has(track.albumId)) continue;
                if (!canSelectArtist(track.album.artist.id, strictArtistCap)) {
                    deferredFallbackTracks.push(track);
                    continue;
                }

                selectedTrackIds.add(track.id);
                selectedAlbumIds.add(track.albumId);
                recordSelectedArtist(track.album.artist.id);

                const fallbackSimilarity = clampSimilarity(
                    applyTrackPreferenceSimilarityBias(
                        0.34 + randomJitter(0.15),
                        fallbackPreferenceScores.get(track.id) ?? 0
                    )
                );
                selected.push({
                    trackId: track.id,
                    title: track.title,
                    duration: track.duration,
                    filePath: track.filePath,
                    albumId: track.albumId,
                    albumTitle: track.album.title,
                    albumMbid: track.album.rgMbid,
                    artistId: track.album.artist.id,
                    artistName: track.album.artist.name,
                    artistMbid: track.album.artist.mbid,
                    coverUrl: track.album.coverUrl,
                    similarity: fallbackSimilarity,
                    tier: similarityToTier(fallbackSimilarity),
                });
            }

            if (selected.length < targetCount) {
                for (const track of deferredFallbackTracks) {
                    if (selected.length >= targetCount) break;
                    if (selectedTrackIds.has(track.id)) continue;
                    if (selectedAlbumIds.has(track.albumId)) continue;
                    if (!canSelectArtist(track.album.artist.id, relaxedArtistCap)) {
                        continue;
                    }

                    selectedTrackIds.add(track.id);
                    selectedAlbumIds.add(track.albumId);
                    recordSelectedArtist(track.album.artist.id);

                    const fallbackSimilarity = clampSimilarity(
                        applyTrackPreferenceSimilarityBias(
                            0.34 + randomJitter(0.15),
                            fallbackPreferenceScores.get(track.id) ?? 0
                        )
                    );
                    selected.push({
                        trackId: track.id,
                        title: track.title,
                        duration: track.duration,
                        filePath: track.filePath,
                        albumId: track.albumId,
                        albumTitle: track.album.title,
                        albumMbid: track.album.rgMbid,
                        artistId: track.album.artist.id,
                        artistName: track.album.artist.name,
                        artistMbid: track.album.artist.mbid,
                        coverUrl: track.album.coverUrl,
                        similarity: fallbackSimilarity,
                        tier: similarityToTier(fallbackSimilarity),
                    });
                }
            }
        }

        return selected.slice(0, targetCount);
    }

    async generatePlaylist(userId: string): Promise<GenerateResult> {
        const userConfig = await this.getOrCreateUserConfig(userId);

        if (!userConfig.enabled) {
            throw new Error("Discovery Weekly not enabled");
        }

        const targetCount = Math.max(5, Math.min(50, userConfig.playlistSize || 10));
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
                    const expiresAt = addMonths(now, userConfig.exclusionMonths);
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
            `[DiscoveryRecommendations] Generated ${selectedTracks.length} recommendation tracks for user ${userId}`
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

        const trackById = new Map(libraryTracks.map((track) => [track.id, track]));

        const tracks: CurrentPlaylistTrack[] = [];

        for (const discoveryAlbum of discoveryAlbums) {
            for (const discoveryTrack of discoveryAlbum.tracks) {
                if (!discoveryTrack.trackId) continue;
                const track = trackById.get(discoveryTrack.trackId);
                if (!track) continue;

                const similarity = clampSimilarity(discoveryAlbum.similarity ?? 0.35);
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

    async clearCurrentPlaylist(userId: string): Promise<{ clearedCount: number }> {
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
