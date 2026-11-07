/**
 * Explore discovery shelves: music that is NOT in the library, tailored to
 * what each user has played and liked inside soundspan.
 *
 * Every external lookup uses the instance-wide (admin) Last.fm API key and
 * the public MusicBrainz API; no user's third-party account is read. Users
 * without any history get global "popular right now" content instead.
 */

import { subDays } from "date-fns";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { isValidMbid } from "../../utils/musicIds";
import {
    extractPrimaryArtist,
    normalizeArtistName,
} from "../../utils/artistNormalization";
import { lastFmService, type LastFmChartTrack } from "../lastfm";
import {
    musicBrainzService,
    type MusicBrainzReleaseGroupSearchResult,
} from "../musicbrainz";

// Scoped lazily so importing this module never depends on logger setup.
function log() {
    return logger.child("ExploreDiscovery");
}

const CACHE_TTL_SECONDS = 30 * 60;
const CACHE_KEY_PREFIX = "explore:discovery:v1";
const PLAY_LOOKBACK_DAYS = 180;
const MAX_PLAYS = 300;
const MAX_LIKES = 200;
const PLAY_WEIGHT = 1;
const LIKE_WEIGHT = 3;
const SIMILAR_SEED_COUNT = 6;
const RELEASE_SEED_COUNT = 12;
const RELEASE_LOOKBACK_DAYS = 90;
const TAG_SHELF_COUNT = 3;
const SHELF_LIMIT = 20;
const TAG_SHELF_LIMIT = 12;
const LASTFM_PLACEHOLDER_IMAGE_ID = "2a96cbd8b46e442fc41c2b86b821562f";

/** Unowned artist card on an Explore discovery shelf. */
export interface ExploreArtist {
    name: string;
    mbid?: string;
    image: string | null;
    /** Seed artist from the user's history that led to this suggestion. */
    because?: string;
}

/** Recent release group not in the library. */
export interface ExploreRelease {
    rgMbid: string;
    title: string;
    artistName: string;
    artistMbid?: string;
    releaseDate: string;
    primaryType?: string;
    coverUrl: string;
}

/** Globally trending track not in the library (search-result shape). */
export interface ExploreTrack {
    type: "track";
    id: string;
    name: string;
    artist: string;
    image?: string;
    listeners?: number;
}

/** Top unowned artists for one tag. */
export interface ExploreTagShelf {
    tag: string;
    artists: ExploreArtist[];
}

/** Full Explore discovery payload. */
export interface ExploreDiscoveryResult {
    /** False when the user has no history and only global content is shown. */
    personalized: boolean;
    similarArtists: ExploreArtist[];
    newReleases: ExploreRelease[];
    trendingTracks: ExploreTrack[];
    tagShelves: ExploreTagShelf[];
}

/** Artist identity contributed by one play or like. */
export interface TasteSignal {
    name: string;
    mbid?: string | null;
    genres?: unknown;
    weight: number;
}

/** Aggregated taste seed for one artist. */
export interface TasteSeed {
    key: string;
    name: string;
    mbid?: string;
    genres: string[];
    weight: number;
}

/** Artist identities already in the library. */
export interface OwnedArtistIndex {
    names: Set<string>;
    mbids: Set<string>;
}

type ArtistRow = {
    name: string;
    mbid: string | null;
    genres: unknown;
    userGenres: unknown;
};

const ARTIST_SELECT = {
    name: true,
    mbid: true,
    genres: true,
    userGenres: true,
} as const;

function toStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

function artistKey(name: string): string {
    return normalizeArtistName(extractPrimaryArtist(name));
}

/** Combine plays and likes into artist seeds, strongest first. */
export function aggregateTasteSeeds(signals: TasteSignal[]): TasteSeed[] {
    const seeds = new Map<string, TasteSeed>();
    for (const signal of signals) {
        const name = signal.name?.trim();
        if (!name) continue;
        const key = artistKey(name);
        if (!key || key === "unknown artist") continue;
        const mbid = isValidMbid(signal.mbid) ? signal.mbid : undefined;
        const existing = seeds.get(key);
        if (existing) {
            existing.weight += signal.weight;
            existing.mbid ??= mbid;
            if (existing.genres.length === 0) {
                existing.genres = toStringList(signal.genres);
            }
            continue;
        }
        seeds.set(key, {
            key,
            name,
            mbid,
            genres: toStringList(signal.genres),
            weight: signal.weight,
        });
    }
    return Array.from(seeds.values()).sort((a, b) => b.weight - a.weight);
}

/** True when the artist is already in the library or is one of the seeds. */
export function isKnownArtist(
    name: string,
    mbid: string | undefined,
    owned: OwnedArtistIndex,
    seedKeys: ReadonlySet<string>,
): boolean {
    const key = artistKey(name);
    if (owned.names.has(key) || seedKeys.has(key)) return true;
    return Boolean(mbid && owned.mbids.has(mbid));
}

/** Pick the tags that best describe the seeds, weighted by seed strength. */
export function pickSeedTags(seeds: TasteSeed[], count: number): string[] {
    const scores = new Map<string, number>();
    for (const seed of seeds) {
        seed.genres.slice(0, 5).forEach((genre, index) => {
            // Earlier genres describe the artist better than later ones.
            const score = seed.weight / (index + 1);
            scores.set(genre, (scores.get(genre) ?? 0) + score);
        });
    }
    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([tag]) => tag);
}

function artistRowToSignal(
    artist: ArtistRow | null | undefined,
    weight: number,
): TasteSignal | null {
    if (!artist) return null;
    return {
        name: artist.name,
        mbid: artist.mbid,
        genres: artist.userGenres ?? artist.genres,
        weight,
    };
}

function remoteToSignal(
    remote:
        | { artist: string; artistEntity: ArtistRow | null }
        | null
        | undefined,
    weight: number,
): TasteSignal | null {
    if (!remote) return null;
    return (
        artistRowToSignal(remote.artistEntity, weight) ?? {
            name: remote.artist,
            weight,
        }
    );
}

const REMOTE_SELECT = {
    select: { artist: true, artistEntity: { select: ARTIST_SELECT } },
} as const;

async function loadTasteSignals(userId: string): Promise<TasteSignal[]> {
    const [plays, likes, remoteLikes] = await Promise.all([
        prisma.play.findMany({
            where: {
                userId,
                playedAt: { gte: subDays(new Date(), PLAY_LOOKBACK_DAYS) },
            },
            orderBy: { playedAt: "desc" },
            take: MAX_PLAYS,
            select: {
                track: {
                    select: {
                        album: {
                            select: { artist: { select: ARTIST_SELECT } },
                        },
                    },
                },
                trackTidal: REMOTE_SELECT,
                trackYtMusic: REMOTE_SELECT,
            },
        }),
        prisma.likedTrack.findMany({
            where: { userId },
            orderBy: { likedAt: "desc" },
            take: MAX_LIKES,
            select: {
                track: {
                    select: {
                        album: {
                            select: { artist: { select: ARTIST_SELECT } },
                        },
                    },
                },
            },
        }),
        prisma.likedRemoteTrack.findMany({
            where: { userId },
            orderBy: { likedAt: "desc" },
            take: MAX_LIKES,
            select: { trackTidal: REMOTE_SELECT, trackYtMusic: REMOTE_SELECT },
        }),
    ]);

    const signals: Array<TasteSignal | null> = [];
    for (const play of plays) {
        signals.push(
            artistRowToSignal(play.track?.album?.artist, PLAY_WEIGHT) ??
                remoteToSignal(play.trackTidal, PLAY_WEIGHT) ??
                remoteToSignal(play.trackYtMusic, PLAY_WEIGHT),
        );
    }
    for (const like of likes) {
        signals.push(artistRowToSignal(like.track?.album?.artist, LIKE_WEIGHT));
    }
    for (const like of remoteLikes) {
        signals.push(
            remoteToSignal(like.trackTidal, LIKE_WEIGHT) ??
                remoteToSignal(like.trackYtMusic, LIKE_WEIGHT),
        );
    }
    return signals.filter((signal): signal is TasteSignal => signal !== null);
}

async function loadOwnedArtists(): Promise<OwnedArtistIndex> {
    const artists = await prisma.artist.findMany({
        where: {
            OR: [
                { ownedAlbums: { some: {} } },
                { libraryAlbumCount: { gt: 0 } },
            ],
        },
        select: { name: true, mbid: true },
    });
    return {
        names: new Set(artists.map((artist) => artistKey(artist.name))),
        mbids: new Set(
            artists
                .map((artist) => artist.mbid)
                .filter((mbid): mbid is string => isValidMbid(mbid)),
        ),
    };
}

async function withImages(
    artists: Array<Omit<ExploreArtist, "image"> & { lastFmImage?: unknown }>,
): Promise<ExploreArtist[]> {
    return Promise.all(
        artists.map(async ({ lastFmImage, ...artist }) => ({
            ...artist,
            image: await lastFmService
                .resolveArtistImage(artist.name, artist.mbid, lastFmImage)
                .catch(() => null),
        })),
    );
}

async function buildSimilarArtists(
    seeds: TasteSeed[],
    owned: OwnedArtistIndex,
    seedKeys: ReadonlySet<string>,
): Promise<ExploreArtist[]> {
    const topSeeds = seeds.slice(0, SIMILAR_SEED_COUNT);
    const maxWeight = topSeeds[0]?.weight ?? 1;
    const similarLists = await Promise.all(
        topSeeds.map((seed) =>
            lastFmService
                .getSimilarArtists(seed.mbid ?? "", seed.name, 30)
                .catch(() => []),
        ),
    );

    const candidates = new Map<
        string,
        {
            name: string;
            mbid?: string;
            score: number;
            because: string;
            best: number;
        }
    >();
    similarLists.forEach((similar, seedIndex) => {
        const seed = topSeeds[seedIndex];
        const seedFactor = seed.weight / maxWeight;
        for (const artist of similar) {
            if (!artist?.name) continue;
            const mbid = isValidMbid(artist.mbid) ? artist.mbid : undefined;
            if (isKnownArtist(artist.name, mbid, owned, seedKeys)) continue;
            const key = artistKey(artist.name);
            const contribution = (artist.match || 0) * seedFactor;
            const existing = candidates.get(key);
            if (!existing) {
                candidates.set(key, {
                    name: artist.name,
                    mbid,
                    score: contribution,
                    because: seed.name,
                    best: contribution,
                });
                continue;
            }
            existing.score += contribution;
            existing.mbid ??= mbid;
            if (contribution > existing.best) {
                existing.best = contribution;
                existing.because = seed.name;
            }
        }
    });

    const ranked = Array.from(candidates.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, SHELF_LIMIT)
        .map(({ name, mbid, because }) => ({ name, mbid, because }));
    return withImages(ranked);
}

function toExploreRelease(
    group: MusicBrainzReleaseGroupSearchResult,
): ExploreRelease | null {
    const releaseDate = group["first-release-date"];
    if (!releaseDate || !isValidMbid(group.id)) return null;
    // Compilations, live albums, remixes etc. are not "new music".
    if ((group["secondary-types"] ?? []).length > 0) return null;
    const credit = group["artist-credit"]?.[0];
    const artistMbid = credit?.artist?.id;
    return {
        rgMbid: group.id,
        title: group.title,
        artistName: credit?.name || credit?.artist?.name || "Unknown Artist",
        artistMbid: isValidMbid(artistMbid) ? artistMbid : undefined,
        releaseDate,
        primaryType: group["primary-type"],
        coverUrl: `https://coverartarchive.org/release-group/${group.id}/front-250`,
    };
}

async function buildNewReleases(
    seeds: TasteSeed[],
    now: Date,
): Promise<ExploreRelease[]> {
    const artistMbids = seeds
        .filter((seed) => seed.mbid)
        .slice(0, RELEASE_SEED_COUNT)
        .map((seed) => seed.mbid as string);
    if (artistMbids.length === 0) return [];

    const toDay = (date: Date) => date.toISOString().slice(0, 10);
    const groups = await musicBrainzService
        .searchRecentReleaseGroupsByArtists(
            artistMbids,
            toDay(subDays(now, RELEASE_LOOKBACK_DAYS)),
            toDay(now),
            50,
        )
        .catch(() => []);

    const releases = groups
        .map(toExploreRelease)
        .filter((release): release is ExploreRelease => release !== null);
    if (releases.length === 0) return [];

    const owned = await prisma.ownedAlbum.findMany({
        where: { rgMbid: { in: releases.map((release) => release.rgMbid) } },
        select: { rgMbid: true },
    });
    const ownedIds = new Set(owned.map((album) => album.rgMbid));
    return releases
        .filter((release) => !ownedIds.has(release.rgMbid))
        .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
        .slice(0, SHELF_LIMIT);
}

function chartTrackArtist(track: LastFmChartTrack): string {
    if (typeof track.artist === "string") return track.artist.trim();
    return track.artist?.name?.trim() ?? "";
}

function chartTrackImage(track: LastFmChartTrack): string | undefined {
    const image = lastFmService.getBestImage(
        Array.isArray(track.image) ? track.image : [],
    );
    if (!image || image.includes(LASTFM_PLACEHOLDER_IMAGE_ID)) return undefined;
    return image;
}

function trackKey(artist: string, title: string): string {
    return `${artistKey(artist)}::${title.trim().toLowerCase()}`;
}

async function buildTrendingTracks(): Promise<ExploreTrack[]> {
    const chart = (await lastFmService.getTopChartTracks(50)).filter(
        (track) => track?.name && chartTrackArtist(track),
    );
    if (chart.length === 0) return [];

    const libraryMatches = await prisma.track.findMany({
        where: {
            removedAt: null,
            title: {
                in: chart.map((track) => track.name),
                mode: "insensitive",
            },
        },
        select: {
            title: true,
            album: { select: { artist: { select: { name: true } } } },
        },
    });
    const ownedTracks = new Set(
        libraryMatches.map((track) =>
            trackKey(track.album.artist.name, track.title),
        ),
    );

    return chart
        .filter(
            (track) =>
                !ownedTracks.has(trackKey(chartTrackArtist(track), track.name)),
        )
        .slice(0, SHELF_LIMIT)
        .map((track) => {
            const artist = chartTrackArtist(track);
            const listeners = Number.parseInt(track.listeners ?? "", 10);
            return {
                type: "track" as const,
                id: `lastfm:${artist}:${track.name}`,
                name: track.name,
                artist,
                image: chartTrackImage(track),
                listeners: Number.isFinite(listeners) ? listeners : undefined,
            };
        });
}

async function buildTagShelves(
    seeds: TasteSeed[],
    owned: OwnedArtistIndex,
    seedKeys: ReadonlySet<string>,
): Promise<ExploreTagShelf[]> {
    let tags = pickSeedTags(seeds, TAG_SHELF_COUNT);
    if (tags.length === 0) {
        const globalTags = await lastFmService.getTopChartTags(TAG_SHELF_COUNT);
        tags = globalTags
            .map((tag) => tag?.name?.trim().toLowerCase())
            .filter((tag): tag is string => Boolean(tag))
            .slice(0, TAG_SHELF_COUNT);
    }

    const shown = new Set<string>();
    const shelves: ExploreTagShelf[] = [];
    for (const tag of tags) {
        const topArtists = await lastFmService.getTopArtistsByTag(tag, 40);
        const picks: Array<
            Omit<ExploreArtist, "image"> & { lastFmImage?: unknown }
        > = [];
        for (const artist of topArtists) {
            if (picks.length >= TAG_SHELF_LIMIT) break;
            if (!artist?.name) continue;
            const mbid = isValidMbid(artist.mbid) ? artist.mbid : undefined;
            const key = artistKey(artist.name);
            if (shown.has(key)) continue;
            if (isKnownArtist(artist.name, mbid, owned, seedKeys)) continue;
            shown.add(key);
            picks.push({ name: artist.name, mbid, lastFmImage: artist.image });
        }
        if (picks.length > 0) {
            shelves.push({ tag, artists: await withImages(picks) });
        }
    }
    return shelves;
}

async function settle<T>(
    label: string,
    work: Promise<T>,
    fallback: T,
): Promise<T> {
    try {
        return await work;
    } catch (error) {
        log().warn(`Explore ${label} shelf failed`, { error });
        return fallback;
    }
}

/**
 * Build (or serve from a 30-minute cache) the Explore discovery shelves for
 * one user. Each shelf degrades to empty independently on provider failure.
 */
export async function getExploreDiscovery(
    userId: string,
    now: Date = new Date(),
): Promise<ExploreDiscoveryResult> {
    const cacheKey = `${CACHE_KEY_PREFIX}:${userId}`;
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return JSON.parse(cached) as ExploreDiscoveryResult;
    } catch (error) {
        log().warn("Explore discovery cache read failed", { error });
    }

    const [seeds, owned] = await Promise.all([
        loadTasteSignals(userId).then(aggregateTasteSeeds),
        loadOwnedArtists(),
    ]);
    const seedKeys = new Set(seeds.map((seed) => seed.key));

    const [similarArtists, newReleases, trendingTracks, tagShelves] =
        await Promise.all([
            settle("similar", buildSimilarArtists(seeds, owned, seedKeys), []),
            settle("new-release", buildNewReleases(seeds, now), []),
            settle("trending", buildTrendingTracks(), []),
            settle("tag", buildTagShelves(seeds, owned, seedKeys), []),
        ]);

    const result: ExploreDiscoveryResult = {
        personalized: seeds.length > 0,
        similarArtists,
        newReleases,
        trendingTracks,
        tagShelves,
    };

    try {
        await redisClient.setEx(
            cacheKey,
            CACHE_TTL_SECONDS,
            JSON.stringify(result),
        );
    } catch (error) {
        log().warn("Explore discovery cache write failed", { error });
    }
    return result;
}
