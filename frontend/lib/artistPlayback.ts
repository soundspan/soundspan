import { api } from "@/lib/api";

export interface ArtistPlaybackAlbum {
    id: string;
    title?: string;
    year?: number | null;
    coverArt?: string | null;
    owned?: boolean;
    artist?: {
        id?: string;
        name?: string;
    };
}

export interface ArtistPlaybackTrack {
    id: string;
    title: string;
    duration: number;
    trackNumber: number;
    artist: {
        id?: string;
        name: string;
    };
    album: {
        id: string;
        title: string;
        coverArt?: string | null;
        year?: number | null;
    };
    /** Present on liked TIDAL / YouTube Music tracks of remote albums. */
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
}

/** Album-level fields shared by every queued track of one album. */
export interface ArtistPlaybackAlbumContext {
    artistId?: string;
    artistName: string;
    albumId: string;
    albumTitle: string;
    coverArt?: string | null;
    year?: number | null;
}

interface LoadOwnedArtistTracksParams {
    artistId: string;
    artistName?: string;
    albums?: ArtistPlaybackAlbum[];
}

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function toOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null) return null;
    return value as Record<string, unknown>;
}

function getTrackSortValue(track: Record<string, unknown>): number {
    return toNumber(
        track.trackNumber ?? track.trackNo ?? track.displayTrackNo,
        0,
    );
}

function getDiscSortValue(track: Record<string, unknown>): number {
    return toNumber(track.discNumber ?? track.discNo, 1);
}

function normalizeAlbums(albums: unknown[]): ArtistPlaybackAlbum[] {
    return albums
        .map((album) => toRecord(album))
        .filter((album): album is Record<string, unknown> => !!album)
        .map((album) => ({
            id: String(album.id),
            title: toOptionalString(album.title),
            year: toNumber(album.year, 0) || undefined,
            coverArt:
                toOptionalString(album.coverArt) ||
                toOptionalString(album.coverUrl),
            artist: toRecord(album.artist)
                ? {
                      id: toOptionalString(toRecord(album.artist)?.id),
                      name: toOptionalString(toRecord(album.artist)?.name),
                  }
                : undefined,
        }))
        .filter((album) => !!album.id);
}

function toStreamFields(
    track: Record<string, unknown>,
): Pick<
    ArtistPlaybackTrack,
    "streamSource" | "tidalTrackId" | "youtubeVideoId"
> {
    const source = track.streamSource ?? track.source;
    if (source !== "tidal" && source !== "youtube") return {};
    const provider = toRecord(track.provider);
    const tidalTrackId = toNumber(
        track.tidalTrackId ?? provider?.tidalTrackId,
        0,
    );
    const youtubeVideoId =
        toOptionalString(track.youtubeVideoId) ??
        toOptionalString(provider?.youtubeVideoId);
    return {
        streamSource: source,
        ...(tidalTrackId > 0 ? { tidalTrackId } : {}),
        ...(youtubeVideoId ? { youtubeVideoId } : {}),
    };
}

/**
 * Maps one album-detail track into a queue entry. Returns null for rows
 * without an id. Streaming fields are kept so remote tracks stay playable.
 */
export function toArtistPlaybackTrack(
    track: Record<string, unknown>,
    context: ArtistPlaybackAlbumContext,
): ArtistPlaybackTrack | null {
    const trackId = toOptionalString(track.id);
    if (!trackId) return null;
    return {
        id: trackId,
        title:
            toOptionalString(track.displayTitle) ||
            toOptionalString(track.title) ||
            "Unknown Track",
        duration: toNumber(track.duration, 0),
        trackNumber: getTrackSortValue(track),
        artist: { id: context.artistId, name: context.artistName },
        album: {
            id: context.albumId,
            title: context.albumTitle,
            coverArt: context.coverArt,
            year: context.year,
        },
        ...toStreamFields(track),
    };
}

function sortAlbumsNewestFirst(
    albums: ArtistPlaybackAlbum[],
): ArtistPlaybackAlbum[] {
    return [...albums].sort(
        (a, b) => toNumber(b.year, 0) - toNumber(a.year, 0),
    );
}

/**
 * Executes loadOwnedArtistTracksNewestFirst.
 */
export async function loadOwnedArtistTracksNewestFirst({
    artistId,
    artistName,
    albums,
}: LoadOwnedArtistTracksParams): Promise<ArtistPlaybackTrack[]> {
    const candidateAlbums =
        albums && albums.length > 0
            ? albums.filter((album) => album.owned !== false)
            : normalizeAlbums(
                  (
                      await api.getAlbums({
                          artistId,
                          filter: "owned",
                          sortBy: "recent",
                          limit: 500,
                      })
                  ).albums || [],
              );

    if (candidateAlbums.length === 0) return [];

    const sortedAlbums = sortAlbumsNewestFirst(candidateAlbums);
    const albumResults = await Promise.all(
        sortedAlbums.map((album) => api.getAlbum(album.id).catch(() => null)),
    );

    const queueTracks: ArtistPlaybackTrack[] = [];

    albumResults.forEach((albumData, albumIndex) => {
        const seedAlbum = sortedAlbums[albumIndex];
        if (
            !albumData ||
            !Array.isArray(albumData.tracks) ||
            albumData.tracks.length === 0
        ) {
            return;
        }

        const sortedTracks = [...albumData.tracks].sort(
            (a: Record<string, unknown>, b: Record<string, unknown>) => {
                const discDiff = getDiscSortValue(a) - getDiscSortValue(b);
                if (discDiff !== 0) return discDiff;
                return getTrackSortValue(a) - getTrackSortValue(b);
            },
        );

        const resolvedArtistName =
            toOptionalString(albumData.artist?.name) ||
            seedAlbum.artist?.name ||
            artistName ||
            "Unknown Artist";
        const resolvedArtistId =
            toOptionalString(albumData.artist?.id) ||
            seedAlbum.artist?.id ||
            artistId;
        const resolvedAlbumTitle =
            toOptionalString(albumData.title) ||
            seedAlbum.title ||
            "Unknown Album";
        const resolvedAlbumId = toOptionalString(albumData.id) || seedAlbum.id;
        const resolvedCoverArt =
            toOptionalString(albumData.coverArt) ??
            toOptionalString(albumData.coverUrl) ??
            seedAlbum.coverArt;

        const context: ArtistPlaybackAlbumContext = {
            artistId: resolvedArtistId,
            artistName: resolvedArtistName,
            albumId: resolvedAlbumId,
            albumTitle: resolvedAlbumTitle,
            coverArt: resolvedCoverArt,
            year: seedAlbum.year,
        };
        sortedTracks.forEach((track: Record<string, unknown>) => {
            const queueTrack = toArtistPlaybackTrack(track, context);
            if (queueTrack) queueTracks.push(queueTrack);
        });
    });

    return queueTracks;
}
