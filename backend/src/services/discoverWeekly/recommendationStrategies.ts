import { subWeeks } from "date-fns";
import { logger } from "../../utils/logger";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { shuffleArray } from "../../utils/shuffle";
import { discoverySeeding } from "../discovery";
import { lastFmService } from "../lastfm";
import { musicBrainzService } from "../musicbrainz";
import { CandidateSelectionService } from "./candidateSelection";
import { getTierFromSimilarity, TIER_DISTRIBUTION } from "./helpers";
import { discoverWeeklyPrisma } from "./state";
import type { RecommendedAlbum, SeedArtist } from "./types";

/** Owns replacement, tag, and tiered recommendation strategies. */
export class RecommendationStrategiesService extends CandidateSelectionService {
    /**
     * Find a replacement album when download fails after all retries.
     * Uses multi-tier fallback prioritizing ARTIST DIVERSITY:
     * - Tier 2: Album from DIFFERENT similar artist (prioritize diversity!)
     * - Tier 3: Another album from SAME artist (last resort fallback)
     */
    async findReplacementAlbum(
        failedJob: any,
        batch: any,
    ): Promise<{
        artistName: string;
        artistMbid: string;
        albumTitle: string;
        albumMbid: string;
        similarity: number;
    } | null> {
        const metadata = failedJob.metadata as any;
        const failedArtistMbid = metadata?.artistMbid;

        logger.debug(
            `[Discovery] Finding replacement for: ${metadata?.artistName} - ${metadata?.albumTitle}`,
        );

        // Get all MBIDs and ARTIST MBIDs already attempted in this batch (for diversity tracking)
        const attemptedMbids = new Set<string>();
        const attemptedArtistMbids = new Set<string>();
        const batchJobs = await discoverWeeklyPrisma.downloadJob.findMany({
            where: { discoveryBatchId: batch.id },
        });
        for (const job of batchJobs) {
            attemptedMbids.add(job.targetMbid);
            const jobMeta = job.metadata as any;
            if (jobMeta?.artistMbid) {
                attemptedArtistMbids.add(jobMeta.artistMbid);
            }
        }

        logger.debug(
            `[Discovery]   Already have ${attemptedArtistMbids.size} artists in batch, prioritizing new artists`,
        );

        // Tier 2: Try album from DIFFERENT similar artist - search ALL seeds with more similar artists
        // IMPORTANT: Never pick same artist twice for diversity!
        logger.debug(
            `[Discovery]   Tier 2: Searching ALL seeds for albums from NEW artists (diversity enforced)`,
        );
        const seeds = await discoverySeeding.getSeedArtists(batch.userId);

        // Search ALL seeds (not just 5) to maximize chances of finding new artists
        for (const seed of seeds) {
            if (!seed.mbid) continue;

            try {
                // Get MORE similar artists per seed (30 instead of 15)
                const similarArtists = await lastFmService.getSimilarArtists(
                    seed.mbid,
                    seed.name,
                    30,
                );

                for (const similar of similarArtists) {
                    // Skip artists we already have in this batch (including the failed artist)
                    if (!similar.mbid) continue;
                    if (similar.mbid === failedArtistMbid) continue;
                    if (attemptedArtistMbids.has(similar.mbid)) {
                        continue; // Skip - we already have an album from this artist
                    }

                    // Get more albums to increase chances of finding available one
                    const albums = await lastFmService.getArtistTopAlbums(
                        similar.mbid,
                        similar.name,
                        5,
                    );

                    for (const album of albums) {
                        // Get MBID from MusicBrainz
                        const mbAlbum = await musicBrainzService.searchAlbum(
                            album.name,
                            similar.name,
                        );

                        if (mbAlbum && !attemptedMbids.has(mbAlbum.id)) {
                            // Check if artist is already in library (Discovery = NEW artists only!)
                            try {
                                const artistInLibrary =
                                    await this.isArtistInLibrary(
                                        similar.name,
                                        similar.mbid,
                                    );
                                if (artistInLibrary) {
                                    logger.debug(
                                        `[Discovery]   Skipping ${similar.name} - already in library`,
                                    );
                                    continue;
                                }
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isArtistInLibrary error for ${similar.name}: ${e.message}`,
                                );
                                // Continue anyway - assume not in library if check fails
                            }

                            // Check if owned
                            try {
                                const owned =
                                    await discoverySeeding.isAlbumOwned(
                                        mbAlbum.id,
                                        batch.userId,
                                    );
                                if (owned) continue;
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isAlbumOwned error: ${e.message}`,
                                );
                                continue; // Skip on error
                            }

                            // Check if excluded
                            try {
                                const excluded = await this.isAlbumExcluded(
                                    mbAlbum.id,
                                    batch.userId,
                                );
                                if (excluded) continue;
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isAlbumExcluded error: ${e.message}`,
                                );
                                continue; // Skip on error
                            }

                            logger.debug(
                                `[Discovery]   Tier 2 replacement found: ${album.name} by ${similar.name} (NEW artist!)`,
                            );
                            return {
                                artistName: similar.name,
                                artistMbid: similar.mbid,
                                albumTitle: album.name,
                                albumMbid: mbAlbum.id,
                                similarity: similar.match || 0.5,
                            };
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }

        // NOTE: Same-artist fallback REMOVED - we enforce strict one-album-per-artist
        // If we can't find a new artist, go straight to library anchor
        logger.debug(
            `[Discovery]   No new artists found, using library anchor (diversity enforced)`,
        );

        // Tier 3: Use track from user's library as anchor (related to discovery seeds)
        logger.debug(
            `[Discovery]   Tier 3: Selecting anchor track from user's library (seed artists)`,
        );
        try {
            // Get a random album from seed artists that user already owns
            for (const seed of seeds.slice(0, 5)) {
                const ownedAlbum = await discoverWeeklyPrisma.album.findFirst({
                    where: {
                        artist: {
                            OR: [
                                { mbid: seed.mbid || "___none___" },
                                {
                                    name: {
                                        equals: seed.name,
                                        mode: "insensitive",
                                    },
                                },
                            ],
                        },
                        tracks: { some: {} }, // Has tracks
                    },
                    include: { artist: true },
                });

                if (
                    ownedAlbum &&
                    ownedAlbum.rgMbid &&
                    !attemptedMbids.has(ownedAlbum.rgMbid)
                ) {
                    logger.debug(
                        `[Discovery]   Tier 3 anchor found: ${ownedAlbum.artist.name} - ${ownedAlbum.title} (from library)`,
                    );
                    return {
                        artistName: ownedAlbum.artist.name,
                        artistMbid: ownedAlbum.artist.mbid,
                        albumTitle: ownedAlbum.title,
                        albumMbid: ownedAlbum.rgMbid,
                        similarity: 1.0, // Library = perfect match
                        isLibraryAnchor: true, // Flag so we know not to download
                    } as any;
                }
            }
        } catch (e) {
            logger.debug(
                `[Discovery]   Tier 3 search failed: ${(e as Error).message}`,
            );
        }

        logger.debug(`[Discovery]   No replacement found`);
        return null;
    }

    /**
     * Get user's top genres from listening history
     */
    private async getUserTopGenres(userId: string): Promise<string[]> {
        try {
            // Get recent plays with artist info
            const recentPlays = await discoverWeeklyPrisma.play.findMany({
                where: {
                    userId,
                    playedAt: { gte: subWeeks(new Date(), 12) }, // Last 3 months
                    track: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                    },
                },
                include: {
                    track: {
                        include: {
                            album: {
                                include: { artist: true },
                            },
                        },
                    },
                },
                take: 500,
            });

            // Collect genres from artists (stored as tags)
            // MERGE canonical genres + user-added genres
            const genreCounts = new Map<string, number>();

            for (const play of recentPlays) {
                const artist = play.track?.album?.artist;
                if (!artist) continue;

                // Collect canonical genres
                if (artist.genres) {
                    const genres = Array.isArray(artist.genres)
                        ? artist.genres
                        : (artist.genres as string)
                              .split(",")
                              .map((g: string) => g.trim());

                    for (const genre of genres) {
                        if (genre && typeof genre === "string") {
                            genreCounts.set(
                                genre.toLowerCase(),
                                (genreCounts.get(genre.toLowerCase()) || 0) + 1,
                            );
                        }
                    }
                }

                // Also collect user-added genres (metadata override system)
                if (artist.userGenres) {
                    const userGenres = Array.isArray(artist.userGenres)
                        ? artist.userGenres
                        : [];

                    for (const genre of userGenres) {
                        if (genre && typeof genre === "string") {
                            genreCounts.set(
                                genre.toLowerCase(),
                                (genreCounts.get(genre.toLowerCase()) || 0) + 1,
                            );
                        }
                    }
                }
            }

            // Sort by count and return top genres
            return Array.from(genreCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([genre]) => genre);
        } catch (error) {
            logger.error("Error getting user genres:", error);
            return [];
        }
    }

    /**
     * TAG EXPLORATION STRATEGY
     * Find albums by the user's top genre tags via Last.fm
     */
    private async tagExplorationStrategy(
        userId: string,
        targetCount: number,
        seenAlbums: Set<string>,
    ): Promise<RecommendedAlbum[]> {
        logger.debug(
            `\n[STRATEGY] Tag Exploration - finding studio albums by genre`,
        );

        const recommendations: RecommendedAlbum[] = [];
        const genres = await this.getUserTopGenres(userId);

        // Patterns to exclude non-studio releases
        const EXCLUDE_PATTERNS = [
            /\blive\b/i,
            /\bep\b$/i,
            /\bacoustic\b/i,
            /\bsession[s]?\b/i,
            /\bcompilation\b/i,
            /\bgreatest\s*hits\b/i,
            /\bbest\s*of\b/i,
            /\bremix(es|ed)?\b/i,
            /\bunplugged\b/i,
            /\bcollection\b/i,
            /\banthology\b/i,
            /\bdemo[s]?\b/i,
        ];

        const isStudioAlbum = (title: string): boolean => {
            return !EXCLUDE_PATTERNS.some((pattern) => pattern.test(title));
        };

        if (genres.length === 0) {
            logger.debug(`   No genres found for user, using fallback tags`);
            genres.push("rock", "indie", "alternative"); // Fallback
        }

        logger.debug(`   User's top genres: ${genres.slice(0, 5).join(", ")}`);

        for (const genre of genres.slice(0, 5)) {
            if (recommendations.length >= targetCount) break;

            try {
                // Use Last.fm's getTopAlbumsByTag
                const tagAlbums = await lastFmService.getTopAlbumsByTag(
                    genre,
                    30,
                );

                for (const album of tagAlbums) {
                    if (recommendations.length >= targetCount) break;

                    const artistName = album.artist?.name || album.artist;
                    if (!artistName || !album.name) continue;

                    // Skip non-studio albums
                    if (!isStudioAlbum(album.name)) continue;

                    // Get MBID from MusicBrainz
                    const mbAlbum = await musicBrainzService.searchAlbum(
                        album.name,
                        artistName,
                    );
                    if (!mbAlbum || seenAlbums.has(mbAlbum.id)) continue;

                    // Check if owned by MBID
                    const owned = await discoverySeeding.isAlbumOwned(
                        mbAlbum.id,
                        userId,
                    );
                    if (owned) continue;

                    // Check if owned by name (catches MBID mismatches)
                    const ownedByName = await this.isAlbumOwnedByName(
                        artistName,
                        album.name,
                    );
                    if (ownedByName) continue;

                    // Check if album was recently recommended (exclusion period)
                    const excluded = await this.isAlbumExcluded(
                        mbAlbum.id,
                        userId,
                    );
                    if (excluded) continue;

                    // Check if artist is in library (prefer new artists)
                    const inLibrary = await this.isArtistInLibrary(
                        artistName,
                        undefined,
                    );
                    if (inLibrary) continue;

                    seenAlbums.add(mbAlbum.id);
                    recommendations.push({
                        artistName,
                        albumTitle: album.name,
                        albumMbid: mbAlbum.id,
                        similarity: 0.7, // Tag-based discovery
                        tier: "wildcard",
                    });
                    logger.debug(
                        `   ✓ TAG: ${artistName} - ${album.name} (${genre})`,
                    );
                }
            } catch (error: any) {
                logger.warn(
                    `   Tag search failed for ${genre}: ${error.message}`,
                );
            }
        }

        logger.debug(
            `   Tag exploration found ${recommendations.length} albums`,
        );
        return recommendations;
    }

    /**
     * Main recommendation engine with tier-based selection
     * Combines similar artists (by tier) + genre wildcards for variety
     *
     * Distribution:
     * - 30% HIGH tier (>70% similar)
     * - 40% MEDIUM tier (50-70% similar)
     * - 20% EXPLORE tier (30-50% similar)
     * - 10% WILDCARD (genre tags)
     */
    async findRecommendedAlbumsMultiStrategy(
        seeds: SeedArtist[],
        similarCache: Map<string, any[]>,
        targetCount: number,
        userId: string,
    ): Promise<RecommendedAlbum[]> {
        const seenAlbums = new Set<string>();
        const seenArtists = new Set<string>();
        const recommendations: RecommendedAlbum[] = [];

        logger.debug(`\n[DISCOVERY] Tier-Based Selection`);
        logger.debug(`   Target: ${targetCount} albums`);
        logger.debug(
            `   Distribution: 30% high, 40% medium, 20% explore, 10% wildcard`,
        );

        // Calculate counts for each tier
        const wildcardCount = Math.max(
            1,
            Math.ceil(targetCount * TIER_DISTRIBUTION.wildcard),
        );
        const similarArtistTarget = targetCount - wildcardCount;

        const highCount = Math.ceil(
            similarArtistTarget * (TIER_DISTRIBUTION.high / 0.9),
        );
        const mediumCount = Math.ceil(
            similarArtistTarget * (TIER_DISTRIBUTION.medium / 0.9),
        );
        const exploreCount = similarArtistTarget - highCount - mediumCount;

        logger.debug(
            `   Targets: ${highCount} high, ${mediumCount} medium, ${exploreCount} explore, ${wildcardCount} wildcard`,
        );

        // Collect all similar artists from all seeds
        const allSimilarArtists: any[] = [];
        for (const seed of seeds) {
            const similar = similarCache.get(seed.mbid || seed.name) || [];
            for (const sim of similar) {
                allSimilarArtists.push(sim);
            }
        }

        // Group similar artists by tier (based on Last.fm match score)
        // Thresholds adjusted for better distribution (Last.fm returns 0.5-0.9 range typically)
        const getArtistMatchScore = (artist: any): number =>
            typeof artist.match === "number" ? artist.match : 0;

        const byTier = {
            high: allSimilarArtists.filter(
                (a) => getArtistMatchScore(a) >= 0.7,
            ),
            medium: allSimilarArtists.filter(
                (a) =>
                    getArtistMatchScore(a) >= 0.5 &&
                    getArtistMatchScore(a) < 0.7,
            ),
            explore: allSimilarArtists.filter(
                (a) =>
                    getArtistMatchScore(a) >= 0.3 &&
                    getArtistMatchScore(a) < 0.5,
            ),
        };

        logger.debug(
            `   Available: ${byTier.high.length} high, ${byTier.medium.length} medium, ${byTier.explore.length} explore`,
        );

        // Debug: Show top artists from each tier with their match scores
        if (byTier.high.length > 0) {
            logger.debug(
                `   HIGH tier sample: ${byTier.high
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.match * 100).toFixed(0)}%)`)
                    .join(", ")}`,
            );
        }
        if (byTier.medium.length > 0) {
            logger.debug(
                `   MEDIUM tier sample: ${byTier.medium
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.match * 100).toFixed(0)}%)`)
                    .join(", ")}`,
            );
        }
        if (byTier.explore.length > 0) {
            logger.debug(
                `   EXPLORE tier sample: ${byTier.explore
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.match * 100).toFixed(0)}%)`)
                    .join(", ")}`,
            );
        }

        // Shuffle each tier for variety week-to-week
        byTier.high = shuffleArray(byTier.high);
        byTier.medium = shuffleArray(byTier.medium);
        byTier.explore = shuffleArray(byTier.explore);

        // Batch-prefetch library membership for every candidate across all three
        // tiers in one query. The "fill remaining slots" loop below draws from
        // this same pool (byTier.* minus seenArtists), so this single prefetch
        // covers both it and the tier loops -- see prefetchArtistLibraryMembership
        // for the exact semantics reproduced. selectFromTier itself stays serial
        // (early break + ordered seenArtists/seenAlbums mutation); only its
        // per-candidate membership check moves off the DB.
        const artistLibraryMembership =
            await this.prefetchArtistLibraryMembership([
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ]);

        // Helper to select from a tier
        const selectFromTier = async (
            tier: any[],
            count: number,
            tierName: "high" | "medium" | "explore",
        ): Promise<RecommendedAlbum[]> => {
            const selected: RecommendedAlbum[] = [];

            for (const artist of tier) {
                if (selected.length >= count) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // Check if artist is in library (prefer NEW artists)
                let artistInLibrary = false;
                try {
                    artistInLibrary = await this.isArtistInLibrary(
                        artist.name,
                        artist.mbid,
                        artistLibraryMembership,
                    );
                } catch (e) {
                    // Continue on error
                }

                if (artistInLibrary) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                // Find a valid album for this artist
                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums,
                );

                if (result.recommendation) {
                    seenArtists.add(key);
                    result.recommendation.tier = tierName;
                    const artistMatch = getArtistMatchScore(artist);
                    result.recommendation.similarity = artistMatch;
                    selected.push(result.recommendation);
                    logger.debug(
                        `    ✓ [${tierName.toUpperCase()}] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${(artistMatch * 100).toFixed(0)}%)`,
                    );
                }
            }

            return selected;
        };

        // Select from each tier
        logger.debug(`\n   === Selecting from HIGH tier ===`);
        const highPicks = await selectFromTier(byTier.high, highCount, "high");
        recommendations.push(...highPicks);

        logger.debug(`\n   === Selecting from MEDIUM tier ===`);
        const mediumPicks = await selectFromTier(
            byTier.medium,
            mediumCount,
            "medium",
        );
        recommendations.push(...mediumPicks);

        logger.debug(`\n   === Selecting from EXPLORE tier ===`);
        const explorePicks = await selectFromTier(
            byTier.explore,
            exploreCount,
            "explore",
        );
        recommendations.push(...explorePicks);

        // If we didn't get enough from tiered selection, fill with any available NEW artists
        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === Filling remaining slots (NEW artists only) ===`,
            );
            const remaining = similarArtistTarget - recommendations.length;
            const allRemaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(allRemaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // Check if artist is in library (same as tier selection)
                let artistInLibrary = false;
                try {
                    artistInLibrary = await this.isArtistInLibrary(
                        artist.name,
                        artist.mbid,
                        artistLibraryMembership,
                    );
                } catch (e) {
                    // Continue on error
                }

                if (artistInLibrary) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums,
                );
                if (result.recommendation) {
                    seenArtists.add(key);
                    const artistMatch = getArtistMatchScore(artist);
                    // Use the artist's actual match score for tier assignment
                    result.recommendation.tier =
                        getTierFromSimilarity(artistMatch);
                    // Also update similarity to use actual match score
                    result.recommendation.similarity = artistMatch;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [FILL] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${(artistMatch * 100).toFixed(0)}%)`,
                    );
                }
            }
        }

        // FALLBACK: If still not enough, allow existing artists with NEW albums
        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === FALLBACK: Existing artists with NEW albums ===`,
            );
            logger.debug(
                `   Need ${
                    similarArtistTarget - recommendations.length
                } more recommendations`,
            );

            const allRemaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(allRemaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // This time we ALLOW artists in library - we just want NEW albums from them
                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums,
                );
                if (result.recommendation) {
                    seenArtists.add(key);
                    const artistMatch = getArtistMatchScore(artist);
                    result.recommendation.tier =
                        getTierFromSimilarity(artistMatch);
                    result.recommendation.similarity = artistMatch;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [EXISTING] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${(artistMatch * 100).toFixed(0)}%)`,
                    );
                }
            }
        }

        // Add genre wildcards for variety
        logger.debug(
            `\n   === Adding ${wildcardCount} WILDCARD picks from genre tags ===`,
        );
        const wildcards = await this.tagExplorationStrategy(
            userId,
            wildcardCount,
            seenAlbums,
        );
        for (const wc of wildcards) {
            wc.tier = "wildcard";
            recommendations.push(wc);
        }

        // Summary
        const tierCounts = {
            high: recommendations.filter((r) => r.tier === "high").length,
            medium: recommendations.filter((r) => r.tier === "medium").length,
            explore: recommendations.filter((r) => r.tier === "explore").length,
            wildcard: recommendations.filter((r) => r.tier === "wildcard")
                .length,
        };

        logger.debug(`\n[DISCOVERY] Final: ${recommendations.length} albums`);
        logger.debug(
            `   High: ${tierCounts.high}, Medium: ${tierCounts.medium}, Explore: ${tierCounts.explore}, Wildcard: ${tierCounts.wildcard}`,
        );

        return recommendations.slice(0, targetCount);
    }
}
