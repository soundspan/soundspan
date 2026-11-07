import { normalizeForExactKey } from "../utils/artistNormalization";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { deezerService } from "./deezer";
import { lastFmService } from "./lastfm";
import type { SearchProvider } from "./searchProviderSettings";
import { tidalStreamingService } from "./tidalStreaming";
import { ytMusicService } from "./youtubeMusic";

const log = logger.child("DiscoverMusicSearch");

/** An artist from a catalog search, outside the library. */
export interface DiscoverArtistResult {
    type: "music";
    id: string;
    name: string;
    source: SearchProvider;
    mbid?: string;
    image?: string | null;
    listeners?: number;
    url?: string | null;
    [key: string]: unknown;
}

/** A track from a catalog search, outside the library. */
export interface DiscoverTrackResult {
    type: "track";
    id: string;
    name: string;
    artist: string;
    album: string | null;
    source: SearchProvider;
    mbid?: string;
    image?: string | null;
    listeners?: number;
    url?: string | null;
    durationSec?: number | null;
    previewUrl?: string | null;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    [key: string]: unknown;
}

/** One provider's results, before merging. */
export interface DiscoverProviderResults {
    provider: SearchProvider;
    artists: DiscoverArtistResult[];
    tracks: DiscoverTrackResult[];
}

interface ProviderSearchInput {
    query: string;
    limit: number;
    userId: string | undefined;
}

type ProviderSearch = (
    input: ProviderSearchInput,
) => Promise<Omit<DiscoverProviderResults, "provider">>;

function tidalImageUrl(picture: unknown): string | null {
    return typeof picture === "string" && picture
        ? `https://resources.tidal.com/images/${picture.replace(/-/g, "/")}/320x320.jpg`
        : null;
}

/**
 * Runs a provider's artist and song searches independently, so a failure in
 * one still returns the other.
 */
async function settleBoth<A, T>(
    provider: SearchProvider,
    artistSearch: () => Promise<A[]>,
    trackSearch: () => Promise<T[]>,
): Promise<{ artists: A[]; tracks: T[] }> {
    const [artists, tracks] = await Promise.allSettled([
        artistSearch(),
        trackSearch(),
    ]);
    if (artists.status === "rejected" && tracks.status === "rejected") {
        throw artists.reason;
    }
    if (artists.status === "rejected") {
        log.warn(`${provider} artist search failed`, { error: artists.reason });
    }
    if (tracks.status === "rejected") {
        log.warn(`${provider} track search failed`, { error: tracks.reason });
    }
    return {
        artists: artists.status === "fulfilled" ? artists.value : [],
        tracks: tracks.status === "fulfilled" ? tracks.value : [],
    };
}

async function searchLastFm({ query, limit }: ProviderSearchInput) {
    const { artists, tracks } = await settleBoth(
        "lastfm",
        () => lastFmService.searchArtists(query, limit),
        () => lastFmService.searchTracks(query, limit),
    );
    // Last.fm rows keep their established shape; only the source is added.
    return {
        artists: artists.map((artist) => ({
            ...(artist as object),
            source: "lastfm" as const,
        })) as DiscoverArtistResult[],
        tracks: tracks.map((track) => ({
            ...(track as object),
            source: "lastfm" as const,
        })) as DiscoverTrackResult[],
    };
}

async function searchDeezer({ query, limit }: ProviderSearchInput) {
    const { artists, tracks } = await settleBoth(
        "deezer",
        () => deezerService.searchArtists(query, limit),
        () => deezerService.searchTracks(query, limit),
    );
    return {
        artists: artists.map((artist) => ({
            type: "music" as const,
            id: `deezer:${artist.deezerId}`,
            name: artist.name,
            image: artist.imageUrl,
            listeners: artist.fans,
            url: artist.url,
            source: "deezer" as const,
        })),
        tracks: tracks.map((track) => ({
            type: "track" as const,
            id: `deezer:${track.deezerId}`,
            name: track.title,
            artist: track.artist,
            album: track.album,
            image: track.coverUrl,
            url: track.url,
            durationSec: track.durationSec,
            previewUrl: track.previewUrl,
            source: "deezer" as const,
        })),
    };
}

async function searchTidal({ query, limit, userId }: ProviderSearchInput) {
    const results = await tidalStreamingService.search(userId!, query);
    const artists: any[] = Array.isArray(results?.artists)
        ? results.artists
        : [];
    const tracks: any[] = Array.isArray(results?.tracks) ? results.tracks : [];
    return {
        artists: artists
            .filter((artist) => artist?.id && artist?.name)
            .slice(0, limit)
            .map((artist) => ({
                type: "music" as const,
                id: `tidal:${artist.id}`,
                name: String(artist.name),
                image: tidalImageUrl(artist.picture),
                source: "tidal" as const,
            })),
        tracks: tracks
            .filter((track) => track?.id && track?.title && track?.artist)
            .slice(0, limit)
            .map((track) => ({
                type: "track" as const,
                id: `tidal:${track.id}`,
                name: String(track.title),
                artist: String(track.artist),
                album: track.album?.title ?? null,
                durationSec: Number(track.duration) || null,
                tidalTrackId: Number(track.id),
                source: "tidal" as const,
            })),
    };
}

async function searchYouTube({ query, limit, userId }: ProviderSearchInput) {
    const response = await ytMusicService.searchCanonical(
        userId!,
        query,
        "songs",
    );
    return {
        artists: [],
        tracks: response.results.slice(0, limit).map((song) => ({
            type: "track" as const,
            id: `youtube:${song.providerTrackId}`,
            name: song.title,
            artist: song.artistName,
            album: song.albumTitle,
            image: song.thumbnailUrl,
            durationSec: song.durationSec,
            youtubeVideoId: song.providerTrackId,
            source: "youtube" as const,
        })),
    };
}

const PROVIDER_SEARCHES: Record<SearchProvider, ProviderSearch> = {
    lastfm: searchLastFm,
    deezer: searchDeezer,
    tidal: searchTidal,
    youtube: searchYouTube,
};

async function isTidalUsable(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    const [enabled, available] = await Promise.all([
        tidalStreamingService.isEnabled(),
        tidalStreamingService.isAvailable(),
    ]);
    if (!enabled || !available) return false;
    const auth = await tidalStreamingService.getAuthStatus(userId);
    return auth.authenticated;
}

async function isYouTubeUsable(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    const settings = await getSystemSettings();
    if (!settings?.ytMusicEnabled) return false;
    return ytMusicService.isAvailable();
}

/**
 * Narrows the admin's enabled providers to the ones this user can search now:
 * TIDAL needs a signed-in (or shared) session and YouTube Music needs the
 * integration enabled and its sidecar up. Order is preserved.
 */
export async function resolveUsableSearchProviders(
    providers: readonly SearchProvider[],
    userId: string | undefined,
): Promise<SearchProvider[]> {
    const checks = await Promise.all(
        providers.map(async (provider) => {
            try {
                if (provider === "tidal") return await isTidalUsable(userId);
                if (provider === "youtube") {
                    return await isYouTubeUsable(userId);
                }
                return true;
            } catch (error) {
                log.warn(`Could not check ${provider} search availability`, {
                    error,
                });
                return false;
            }
        }),
    );
    return providers.filter((_provider, index) => checks[index]);
}

function textKey(value: unknown): string {
    return typeof value === "string" ? normalizeForExactKey(value) : "";
}

function trackKey(track: DiscoverTrackResult): string {
    const artist = textKey(track.artist);
    const title = textKey(track.name);
    return artist && title ? `${artist}\u0000${title}` : "";
}

/**
 * Merges provider results in priority order. A result whose artist (or
 * artist and title, for tracks) already came from a higher-priority provider
 * is dropped, and each type is capped at `limit`. A row without a usable name
 * is kept but never used to drop another.
 */
export function mergeDiscoverProviderResults(
    ordered: readonly DiscoverProviderResults[],
    limit: number,
): { artists: DiscoverArtistResult[]; tracks: DiscoverTrackResult[] } {
    const artists: DiscoverArtistResult[] = [];
    const tracks: DiscoverTrackResult[] = [];
    const seenArtists = new Set<string>();
    const seenTracks = new Set<string>();
    for (const result of ordered) {
        for (const artist of result.artists) {
            const key = textKey(artist.name);
            if (artists.length >= limit || (key && seenArtists.has(key))) {
                continue;
            }
            if (key) seenArtists.add(key);
            artists.push(artist);
        }
        for (const track of result.tracks) {
            const key = trackKey(track);
            if (tracks.length >= limit || (key && seenTracks.has(key))) {
                continue;
            }
            if (key) seenTracks.add(key);
            tracks.push(track);
        }
    }
    return { artists, tracks };
}

/**
 * Searches every given provider in parallel and merges the results in the
 * given priority order. A provider that fails is logged and skipped.
 */
export async function searchDiscoverMusic(input: {
    query: string;
    limit: number;
    userId: string | undefined;
    providers: readonly SearchProvider[];
}): Promise<{
    artists: DiscoverArtistResult[];
    tracks: DiscoverTrackResult[];
}> {
    const settled = await Promise.allSettled(
        input.providers.map((provider) => PROVIDER_SEARCHES[provider](input)),
    );
    const ordered: DiscoverProviderResults[] = [];
    settled.forEach((result, index) => {
        const provider = input.providers[index];
        if (result.status === "fulfilled") {
            ordered.push({ provider, ...result.value });
            return;
        }
        log.warn(`${provider} search failed`, { error: result.reason });
    });
    return mergeDiscoverProviderResults(ordered, input.limit);
}
