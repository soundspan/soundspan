/**
 * Discovery Seeding Module
 *
 * Handles seed artist selection for discovering new music based on:
 * - User's listening history (recent plays)
 * - Library contents (fallback when insufficient history)
 * - Album ownership checking across multiple sources
 */

import { prisma } from "../../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import { logger } from "../../utils/logger";
import { lidarrService } from "../lidarr";
import {
    createSeededRng,
    DEFAULT_ARTIST_WEIGHT_ALPHA,
    getSeededRandom,
} from "../artistSlotAllocation";
import { format, startOfWeek, subWeeks } from "date-fns";

/** Artist identity returned for Discover Weekly metadata seeding. */
export interface SeedArtist {
    name: string;
    mbid?: string;
}

type RecentPlayCount = {
    trackId: string | null;
    _count: { id: number };
};

type SeedTrack = {
    id: string;
    album: {
        artistId: string;
        artist: {
            name: string;
            mbid: string | null;
        };
    };
};

type WeightedSeedArtist = {
    artist: SeedArtist;
    playCount: number;
    firstSeenIndex: number;
};

/** Aggregate track play counts into valid artist-level seed weights. */
function aggregateArtistPlayCounts(
    recentPlays: RecentPlayCount[],
    tracks: SeedTrack[],
    isValidMbid: (mbid: string | null | undefined) => mbid is string,
): WeightedSeedArtist[] {
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const artistWeights = new Map<string, WeightedSeedArtist>();
    for (let index = 0; index < recentPlays.length; index += 1) {
        const play = recentPlays[index];
        const track = play.trackId ? trackById.get(play.trackId) : undefined;
        if (!track || !isValidMbid(track.album.artist.mbid)) continue;

        const existing = artistWeights.get(track.album.artistId);
        if (existing) {
            existing.playCount += play._count.id;
            continue;
        }
        artistWeights.set(track.album.artistId, {
            artist: {
                name: track.album.artist.name,
                mbid: track.album.artist.mbid,
            },
            playCount: play._count.id,
            firstSeenIndex: index,
        });
    }
    return Array.from(artistWeights.values());
}

/**
 * Weighted-sample artists without replacement using Efraimidis-Spirakis keys.
 */
function sampleSeedArtists(
    artists: WeightedSeedArtist[],
    limit: number,
    rng: () => number,
): SeedArtist[] {
    return [...artists]
        .sort(
            (left, right) =>
                (left.artist.mbid ?? "").localeCompare(
                    right.artist.mbid ?? "",
                ) || left.artist.name.localeCompare(right.artist.name),
        )
        .map((entry) => ({
            ...entry,
            key: Math.pow(
                rng(),
                1 / Math.pow(entry.playCount, DEFAULT_ARTIST_WEIGHT_ALPHA),
            ),
        }))
        .sort(
            (left, right) =>
                right.key - left.key ||
                left.firstSeenIndex - right.firstSeenIndex,
        )
        .slice(0, limit)
        .map((entry) => entry.artist);
}

/**
 * Represents the DiscoverySeeding class.
 */
export class DiscoverySeeding {
    private readonly DEFAULT_SEED_COUNT = 10;
    private readonly MIN_PLAYS_THRESHOLD = 5;
    private readonly RECENT_PLAYS_LIMIT = 50;

    /**
     * Gets seed artists based on user's listening history.
     * Falls back to library artists when insufficient play history.
     */
    async getSeedArtists(
        userId: string,
        seedCount?: number,
    ): Promise<SeedArtist[]> {
        const limit = seedCount ?? this.DEFAULT_SEED_COUNT;
        const fourWeeksAgo = subWeeks(new Date(), 4);

        const recentPlays = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                playedAt: { gte: fourWeeksAgo },
                source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
            },
            _count: { id: true },
            orderBy: [{ _count: { id: "desc" } }, { trackId: "asc" }],
            take: this.RECENT_PLAYS_LIMIT,
        });

        if (recentPlays.length < this.MIN_PLAYS_THRESHOLD) {
            return this.getFallbackSeedArtists(limit);
        }

        const recentTrackIds = recentPlays
            .map((play) => play.trackId)
            .filter(
                (trackId): trackId is string => typeof trackId === "string",
            );
        if (recentTrackIds.length === 0) {
            return this.getFallbackSeedArtists(limit);
        }

        const tracks = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                id: { in: recentTrackIds },
                album: { location: { in: ["LIBRARY", "FEDERATED"] } },
            },
            include: { album: { include: { artist: true } } },
        });

        const weightedArtists = aggregateArtistPlayCounts(
            recentPlays,
            tracks,
            (mbid): mbid is string => this.isValidMbid(mbid),
        );
        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const weekKey = format(weekStart, "yyyy-MM-dd");
        const rng = createSeededRng(
            getSeededRandom(`discover-seeds-${userId}-${weekKey}`),
        );
        const artists = sampleSeedArtists(weightedArtists, limit, rng);
        logger.debug(
            `[DiscoverySeeding] Found ${artists.length} seed artists from play history`,
        );
        return artists;
    }

    /**
     * Fallback: Get artists with most albums in library when play history is insufficient.
     */
    private async getFallbackSeedArtists(limit: number): Promise<SeedArtist[]> {
        logger.debug(
            "[DiscoverySeeding] Insufficient play history, falling back to library",
        );

        const albums = await prisma.album.groupBy({
            by: ["artistId"],
            where: {
                OR: [
                    { location: "LIBRARY" },
                    {
                        location: "FEDERATED",
                        tracks: {
                            some: {
                                ...TRACK_VISIBLE_WHERE,
                                ...TRACK_BROWSE_WHERE,
                            },
                        },
                    },
                ],
            },
            _count: { id: true },
            orderBy: { _count: { id: "desc" } },
            take: limit,
        });

        const artists = await prisma.artist.findMany({
            where: { id: { in: albums.map((a) => a.artistId) } },
        });

        return artists
            .filter((a) => this.isValidMbid(a.mbid))
            .map((a) => ({ name: a.name, mbid: a.mbid }));
    }

    /**
     * Checks if an artist is already in the user's library (has albums).
     * Discovery should find NEW artists, not more albums from artists they already own.
     */
    async isArtistInLibrary(artistMbid: string): Promise<boolean> {
        if (!this.isValidMbid(artistMbid)) {
            return false;
        }

        const artist = await prisma.artist.findFirst({
            where: { mbid: artistMbid },
            include: { albums: { take: 1 } },
        });

        if (artist && artist.albums.length > 0) {
            logger.debug(
                `[DiscoverySeeding] Artist ${artistMbid} is in library`,
            );
            return true;
        }

        return false;
    }

    /**
     * Checks if an album is already owned through any source:
     * - OwnedAlbum table
     * - Album table
     * - Previous discovery
     * - Pending downloads
     * - Lidarr
     */
    async isAlbumOwned(albumMbid: string, userId: string): Promise<boolean> {
        const ownedAlbum = await prisma.ownedAlbum.findFirst({
            where: { rgMbid: albumMbid },
        });
        if (ownedAlbum) return true;

        const existingAlbum = await prisma.album.findFirst({
            where: { rgMbid: albumMbid },
        });
        if (existingAlbum) return true;

        const previousDiscovery = await prisma.discoveryAlbum.findFirst({
            where: { rgMbid: albumMbid, userId },
        });
        if (previousDiscovery) return true;

        const pendingDownload = await prisma.downloadJob.findFirst({
            where: {
                targetMbid: albumMbid,
                status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
            },
        });
        if (pendingDownload) return true;

        const inLidarr = await lidarrService.isAlbumAvailable(albumMbid);
        if (inLidarr) return true;

        return false;
    }

    /**
     * Validates that an MBID is not null/undefined and not a temporary ID.
     */
    private isValidMbid(mbid: string | null | undefined): mbid is string {
        return !!mbid && !mbid.startsWith("temp-");
    }
}

export const discoverySeeding = new DiscoverySeeding();
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../downloadJobStatus";
