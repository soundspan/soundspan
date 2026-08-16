import { logger } from "../../utils/logger";
import { lastFmService } from "../lastfm";
import { musicBrainzService } from "../musicbrainz";
import { discoverySeeding } from "../discovery";
import { discoverWeeklyPrisma } from "./state";
import type {
    ArtistLibraryMembership,
    RecommendedAlbum,
    SeedArtist,
} from "./types";

/** Owns candidate eligibility and album selection for Discover Weekly. */
export class CandidateSelectionService {
    /**
     * Check if an artist is already in the user's library
     * Discovery should find NEW artists, not more albums from artists they already own
     *
     * @param membership Optional pre-batched membership map (see
     *   prefetchArtistLibraryMembership). When supplied, this replays the exact
     *   decision below (MBID probe, falling through to the name probe on a miss
     *   OR a zero-album MBID hit -- these are two independent checks, not
     *   mbid-first-else-name) against the pre-fetched maps instead of issuing
     *   per-candidate DB round trips. Callers that don't pass a membership map
     *   (the three single-artist call sites elsewhere in this file) fall
     *   through to the original per-call DB behavior, unchanged.
     */
    protected async isArtistInLibrary(
        artistName: string,
        artistMbid: string | undefined,
        membership?: ArtistLibraryMembership,
    ): Promise<boolean> {
        if (membership) {
            if (
                artistMbid &&
                !artistMbid.startsWith("temp-") &&
                membership.mbidHasAlbum.get(artistMbid)
            ) {
                return true;
            }
            return (
                membership.nameHasAlbum.get(artistName.toLowerCase()) === true
            );
        }

        // Check by MBID first (most accurate)
        if (artistMbid && !artistMbid.startsWith("temp-")) {
            const byMbid = await discoverWeeklyPrisma.artist.findFirst({
                where: { mbid: artistMbid },
                include: { albums: { take: 1 } },
            });
            if (byMbid && byMbid.albums.length > 0) {
                logger.debug(
                    `     [LIBRARY] ${artistName} IN LIBRARY (matched by MBID, ${byMbid.albums.length} album(s))`,
                );
                return true;
            }
        }

        // Check by name (case insensitive)
        const byName = await discoverWeeklyPrisma.artist.findFirst({
            where: {
                name: { equals: artistName, mode: "insensitive" },
            },
            include: { albums: { take: 1 } },
        });

        if (byName !== null && byName.albums.length > 0) {
            logger.debug(
                `     [LIBRARY] ${artistName} IN LIBRARY (matched by name, ${byName.albums.length} album(s))`,
            );
            return true;
        }

        return false;
    }

    /**
     * Batch-prefetch library membership for a set of Discover Weekly candidate
     * artists. Replaces up to 2 DB round trips per candidate
     * (isArtistInLibrary's MBID + name probes, called once per tier/fill-loop
     * candidate) with one query for the whole candidate set.
     *
     * Semantics MUST mirror isArtistInLibrary exactly -- see that method's
     * fast path, which this map feeds:
     *  - MBID probe only considers non-"temp-" mbids (library artists carry
     *    temp- MBIDs by convention and are deliberately excluded there).
     *  - An MBID hit with zero albums is NOT a library hit -- it falls through
     *    to the name probe (two independent probes, not mbid-first-else-name).
     *  - Name matching is case-insensitive equality against Artist.name (NOT
     *    normalizedName -- a different column/normalization).
     *  - "Has an album" mirrors the original `include: { albums: { take: 1 } }`
     *    existence check.
     *
     * Case-insensitive batching: Prisma's `in` filter is case-sensitive, so a
     * single `name: { in: [...] }` can't reproduce Postgres's insensitive
     * equals. We OR together one `{ name: { equals, mode: "insensitive" } }`
     * clause per unique candidate name -- fine at Discover Weekly tier sizes
     * (tens to low hundreds of candidates per run) -- so Postgres itself does
     * the insensitive comparison, rather than fetching broadly and
     * lower-casing in JS. We still key the resulting Map by `.toLowerCase()`
     * to match returned rows back to candidates, which can in principle
     * diverge from Postgres's insensitive-equals on exotic locale characters;
     * acceptable at this library's scale, and the parity test
     * (discoverWeeklyPrefilterParity.test.ts) is the arbiter of equivalence,
     * not this comment.
     *
     * On any query failure, degrades to empty maps (i.e. every candidate
     * classifies as not-in-library) -- the same effective default the
     * original per-candidate try/catch call sites already had.
     */
    protected async prefetchArtistLibraryMembership(
        candidates: Array<{ name: string; mbid?: string }>,
    ): Promise<ArtistLibraryMembership> {
        const mbidHasAlbum = new Map<string, boolean>();
        const nameHasAlbum = new Map<string, boolean>();

        const nonTempMbids = Array.from(
            new Set(
                candidates
                    .map((c) => c.mbid)
                    .filter(
                        (mbid): mbid is string =>
                            !!mbid && !mbid.startsWith("temp-"),
                    ),
            ),
        );
        const uniqueNames = Array.from(
            new Set(
                candidates
                    .map((c) => c.name)
                    .filter((name): name is string => !!name),
            ),
        );

        if (nonTempMbids.length === 0 && uniqueNames.length === 0) {
            return { mbidHasAlbum, nameHasAlbum };
        }

        try {
            const orClauses: Array<
                | { mbid: { in: string[] } }
                | { name: { equals: string; mode: "insensitive" } }
            > = [];
            if (nonTempMbids.length > 0) {
                orClauses.push({ mbid: { in: nonTempMbids } });
            }
            for (const name of uniqueNames) {
                orClauses.push({ name: { equals: name, mode: "insensitive" } });
            }

            const rows = await discoverWeeklyPrisma.artist.findMany({
                where: { OR: orClauses },
                include: { albums: { take: 1 } },
            });

            for (const row of rows) {
                const hasAlbum = row.albums.length > 0;
                mbidHasAlbum.set(
                    row.mbid,
                    hasAlbum || mbidHasAlbum.get(row.mbid) === true,
                );
                const key = row.name.toLowerCase();
                nameHasAlbum.set(
                    key,
                    hasAlbum || nameHasAlbum.get(key) === true,
                );
            }
        } catch (error) {
            logger.warn(
                "   Failed to batch-prefetch artist library membership; treating all candidates as not-in-library for this run",
                error,
            );
        }

        return { mbidHasAlbum, nameHasAlbum };
    }

    /**
     * Check if an album is owned by artist name + album title
     * This catches cases where the MBID doesn't match but the album exists
     */
    protected async isAlbumOwnedByName(
        artistName: string,
        albumTitle: string,
    ): Promise<boolean> {
        // Normalize for comparison
        const normalizedArtist = artistName.toLowerCase().trim();
        const normalizedAlbum = albumTitle
            .toLowerCase()
            .replace(/\(.*?\)/g, "") // Remove parenthetical content
            .replace(/\[.*?\]/g, "") // Remove bracketed content
            .replace(
                /[-–—]\s*(deluxe|remaster|bonus|special|anniversary|expanded|limited|collector).*$/i,
                "",
            )
            .trim();

        // Check Album table by name
        const album = await discoverWeeklyPrisma.album.findFirst({
            where: {
                title: { contains: normalizedAlbum, mode: "insensitive" },
                artist: {
                    name: { contains: normalizedArtist, mode: "insensitive" },
                },
            },
        });
        if (album) {
            logger.debug(
                `     [OWNED-NAME] Found "${albumTitle}" by "${artistName}" in Album table`,
            );
            return true;
        }

        // Check OwnedAlbum by looking up associated Album records through rgMbid
        const ownedAlbumRefs = await discoverWeeklyPrisma.ownedAlbum.findMany({
            where: {
                artist: {
                    name: { contains: normalizedArtist, mode: "insensitive" },
                },
            },
            select: { rgMbid: true },
        });

        // Look up the actual album titles for these owned albums
        if (ownedAlbumRefs.length > 0) {
            const rgMbids = ownedAlbumRefs.map((o) => o.rgMbid);
            const ownedAlbumRecords = await discoverWeeklyPrisma.album.findMany(
                {
                    where: { rgMbid: { in: rgMbids } },
                    select: { title: true },
                },
            );

            for (const owned of ownedAlbumRecords) {
                const ownedNormalized = owned.title
                    ?.toLowerCase()
                    .replace(/\(.*?\)/g, "")
                    .replace(/\[.*?\]/g, "")
                    .trim();
                if (
                    ownedNormalized &&
                    (ownedNormalized.includes(normalizedAlbum) ||
                        normalizedAlbum.includes(ownedNormalized))
                ) {
                    logger.debug(
                        `     [OWNED-NAME] Found "${albumTitle}" by "${artistName}" in OwnedAlbum table`,
                    );
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Check if album was recommended recently (6 months)
     */
    protected async isAlbumExcluded(
        albumMbid: string,
        userId: string,
    ): Promise<boolean> {
        const exclusion =
            await discoverWeeklyPrisma.discoverExclusion.findFirst({
                where: {
                    userId,
                    albumMbid,
                    expiresAt: { gt: new Date() },
                },
            });
        return !!exclusion;
    }

    /**
     * Find recommended albums using pre-cached similar artists
     * TWO-PASS APPROACH:
     * 1. First pass: Prioritize NEW artists (not in library)
     * 2. Second pass: Fall back to existing artists if needed
     */
    private async findRecommendedAlbums(
        seeds: SeedArtist[],
        similarCache: Map<string, any[]>,
        targetCount: number,
        userId: string,
    ): Promise<RecommendedAlbum[]> {
        const recommendations: RecommendedAlbum[] = [];
        const seenArtists = new Set<string>();
        const seenAlbums = new Set<string>();
        const existingArtistsForFallback: any[] = []; // Artists in library saved for second pass

        logger.debug(`\n Finding ${targetCount} recommended albums...`);
        logger.debug(`   Seeds: ${seeds.map((s) => s.name).join(", ")}`);

        let totalSimilarArtists = 0;
        let totalAlbumsChecked = 0;
        let skippedNoMbid = 0;
        let skippedOwned = 0;
        let skippedExcluded = 0;
        let skippedDuplicate = 0;
        let skippedArtistInLibrary = 0;
        let addedFromExistingArtists = 0;

        // Collect all similar artists from all seeds
        const allSimilarArtists: any[] = [];
        for (const seed of seeds) {
            const similar = similarCache.get(seed.mbid || seed.name) || [];
            for (const sim of similar) {
                allSimilarArtists.push(sim);
            }
        }
        logger.debug(
            `   Total similar artists from all seeds: ${allSimilarArtists.length}`,
        );

        logger.debug(`\n   === PASS 1: NEW Artists Only ===`);

        for (const sim of allSimilarArtists) {
            if (recommendations.length >= targetCount) break;

            const key = sim.name.toLowerCase();
            if (seenArtists.has(key)) continue;
            seenArtists.add(key);
            totalSimilarArtists++;

            // Check if artist is in library
            let artistInLibrary = false;
            try {
                artistInLibrary = await this.isArtistInLibrary(
                    sim.name,
                    sim.mbid,
                );
            } catch (e: any) {
                logger.error(
                    `     isArtistInLibrary ERROR for ${sim.name}: ${e.message}`,
                );
            }

            if (artistInLibrary) {
                skippedArtistInLibrary++;
                existingArtistsForFallback.push(sim); // Save for second pass
                continue;
            }

            // Process albums for this NEW artist
            const album = await this.findValidAlbumForArtist(
                sim,
                userId,
                seenAlbums,
            );
            if (album) {
                totalAlbumsChecked += album.albumsChecked;
                skippedNoMbid += album.skippedNoMbid;
                skippedOwned += album.skippedOwned;
                skippedExcluded += album.skippedExcluded;
                skippedDuplicate += album.skippedDuplicate;

                if (album.recommendation) {
                    recommendations.push(album.recommendation);
                    logger.debug(
                        `    ✓ ADDED (NEW): ${sim.name} - ${album.recommendation.albumTitle}`,
                    );
                }
            }
        }

        logger.debug(
            `   Pass 1 complete: ${recommendations.length}/${targetCount} from NEW artists`,
        );

        if (
            recommendations.length < targetCount &&
            existingArtistsForFallback.length > 0
        ) {
            logger.debug(`\n   === PASS 2: Existing Artists (fallback) ===`);
            logger.debug(
                `   Need ${targetCount - recommendations.length} more, have ${
                    existingArtistsForFallback.length
                } existing artists to try`,
            );

            for (const sim of existingArtistsForFallback) {
                if (recommendations.length >= targetCount) break;

                // Process albums for this EXISTING artist (find new albums they don't own)
                const album = await this.findValidAlbumForArtist(
                    sim,
                    userId,
                    seenAlbums,
                );
                if (album) {
                    totalAlbumsChecked += album.albumsChecked;
                    skippedNoMbid += album.skippedNoMbid;
                    skippedOwned += album.skippedOwned;
                    skippedExcluded += album.skippedExcluded;
                    skippedDuplicate += album.skippedDuplicate;

                    if (album.recommendation) {
                        recommendations.push(album.recommendation);
                        addedFromExistingArtists++;
                        logger.debug(
                            `    ✓ ADDED (EXISTING): ${sim.name} - ${album.recommendation.albumTitle}`,
                        );
                    }
                }
            }

            logger.debug(
                `   Pass 2 complete: Added ${addedFromExistingArtists} from existing artists`,
            );
        }

        // Summary logging
        logger.debug(`\n   === Recommendation Summary ===`);
        logger.debug(`   Similar artists checked: ${totalSimilarArtists}`);
        logger.debug(
            `   Artists already in library (fallback pool): ${skippedArtistInLibrary}`,
        );
        logger.debug(`   Albums checked: ${totalAlbumsChecked}`);
        logger.debug(`   Skipped (no MBID from MusicBrainz): ${skippedNoMbid}`);
        logger.debug(`   Skipped (album already owned): ${skippedOwned}`);
        logger.debug(
            `   Skipped (excluded - recently recommended): ${skippedExcluded}`,
        );
        logger.debug(`   Skipped (duplicate): ${skippedDuplicate}`);
        logger.debug(` Found ${recommendations.length} albums total`);
        logger.debug(
            `     - ${
                recommendations.length - addedFromExistingArtists
            } from NEW artists`,
        );
        logger.debug(
            `     - ${addedFromExistingArtists} from EXISTING artists (fallback)`,
        );

        if (recommendations.length === 0 && totalSimilarArtists === 0) {
            logger.debug(
                `   [WARN] No similar artists found! Check Last.fm API configuration.`,
            );
        } else if (recommendations.length === 0 && totalAlbumsChecked === 0) {
            logger.debug(
                `   [WARN] No albums returned from Last.fm! Check getArtistTopAlbums.`,
            );
        } else if (
            recommendations.length === 0 &&
            skippedNoMbid === totalAlbumsChecked
        ) {
            logger.debug(
                `   [WARN] All albums failed MusicBrainz lookup! Check searchAlbum.`,
            );
        } else if (
            recommendations.length === 0 &&
            skippedOwned >= totalAlbumsChecked
        ) {
            logger.debug(
                `   [WARN] All albums already owned! Need more variety in similar artists.`,
            );
        }

        return recommendations;
    }

    /**
     * Helper: Find a valid album for a given artist
     * Returns the first album that passes all checks (owned, excluded, etc.)
     */
    protected async findValidAlbumForArtist(
        artist: any,
        userId: string,
        seenAlbums: Set<string>,
    ): Promise<{
        recommendation: RecommendedAlbum | null;
        albumsChecked: number;
        skippedNoMbid: number;
        skippedOwned: number;
        skippedExcluded: number;
        skippedDuplicate: number;
    }> {
        let albumsChecked = 0;
        let skippedNoMbid = 0;
        let skippedOwned = 0;
        let skippedExcluded = 0;
        let skippedDuplicate = 0;

        // Patterns to exclude non-studio releases
        const EXCLUDE_PATTERNS = [
            /\blive\b/i,
            /\bep\b$/i, // Only at end of title
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

        try {
            // Get 10 albums per artist (was 5) to increase chances of finding available content
            const topAlbums = await lastFmService.getArtistTopAlbums(
                artist.mbid || "",
                artist.name,
                10,
            );

            if (topAlbums.length === 0) {
                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            }

            for (const album of topAlbums) {
                albumsChecked++;

                // Skip non-studio albums (live, compilations, EPs, etc.)
                if (!isStudioAlbum(album.name)) {
                    continue;
                }

                // Get MBID from MusicBrainz
                const mbAlbum = await musicBrainzService.searchAlbum(
                    album.name,
                    artist.name,
                );

                if (!mbAlbum) {
                    skippedNoMbid++;
                    continue;
                }

                // Skip duplicates
                if (seenAlbums.has(mbAlbum.id)) {
                    skippedDuplicate++;
                    continue;
                }
                seenAlbums.add(mbAlbum.id);

                // Skip if owned by MBID
                try {
                    const owned = await discoverySeeding.isAlbumOwned(
                        mbAlbum.id,
                        userId,
                    );
                    if (owned) {
                        skippedOwned++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Skip if owned by name (catches MBID mismatches)
                try {
                    const ownedByName = await this.isAlbumOwnedByName(
                        artist.name,
                        album.name,
                    );
                    if (ownedByName) {
                        skippedOwned++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Check if album was recently recommended (exclusion period)
                try {
                    const excluded = await this.isAlbumExcluded(
                        mbAlbum.id,
                        userId,
                    );
                    if (excluded) {
                        skippedExcluded++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Found a valid album!
                return {
                    recommendation: {
                        artistName: artist.name,
                        artistMbid: artist.mbid,
                        albumTitle: album.name,
                        albumMbid: mbAlbum.id,
                        similarity: artist.match || 0.5,
                    },
                    albumsChecked,
                    skippedNoMbid,
                    skippedOwned,
                    skippedExcluded,
                    skippedDuplicate,
                };
            }
        } catch (error: any) {
            logger.warn(
                `   Failed to get albums for ${artist.name}: ${error.message}`,
            );
        }

        return {
            recommendation: null,
            albumsChecked,
            skippedNoMbid,
            skippedOwned,
            skippedExcluded,
            skippedDuplicate,
        };
    }
}
