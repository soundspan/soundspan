import { logger } from "../utils/logger";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("RemoteTrackMetadataResolver")
        : logger;

const DEFAULT_REMOTE_TITLE = "Unknown";
const DEFAULT_REMOTE_ARTIST = "Unknown";
const DEFAULT_REMOTE_ALBUM = "Unknown";
const DEFAULT_REMOTE_DURATION = 180;

const TITLE_PLACEHOLDERS = new Set(["", "unknown", "unknown track"]);
const ARTIST_PLACEHOLDERS = new Set(["", "unknown", "unknown artist"]);
const ALBUM_PLACEHOLDERS = new Set([
    "",
    "single",
    "unknown",
    "unknown album",
]);

/**
 * Remote metadata supplied by clients or fetched from provider APIs.
 */
export interface RemoteTrackMetadataInput {
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    thumbnailUrl?: string;
    isrc?: string;
    quality?: string;
    explicit?: boolean;
}

/**
 * Fully-normalized remote metadata safe to persist in TrackTidal / TrackYtMusic.
 */
export interface ResolvedRemoteTrackMetadata {
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl?: string;
    isrc?: string;
    quality?: string;
    explicit?: boolean;
}

/**
 * Route-facing lookup descriptor for a remote provider track.
 */
export interface RemoteTrackLookup {
    provider: "tidal" | "youtube";
    userId: string;
    tidalId?: number;
    videoId?: string;
    metadata: RemoteTrackMetadataInput;
}

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}

function isPlaceholderValue(
    field: "title" | "artist" | "album",
    value: string | undefined
): boolean {
    if (!value) {
        return true;
    }

    const normalized = value.trim().toLowerCase();
    if (field === "title") {
        return TITLE_PLACEHOLDERS.has(normalized);
    }
    if (field === "artist") {
        return ARTIST_PLACEHOLDERS.has(normalized);
    }
    return ALBUM_PLACEHOLDERS.has(normalized);
}

function normalizeDuration(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.trunc(value);
}

function pickBestThumbnailUrl(thumbnails: unknown): string | undefined {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
        return undefined;
    }

    const urls = thumbnails
        .map((thumbnail) =>
            typeof thumbnail === "object" && thumbnail !== null
                ? normalizeOptionalString((thumbnail as { url?: string }).url)
                : undefined
        )
        .filter((url): url is string => typeof url === "string");

    return urls.at(-1);
}

function normalizeResolvedMetadata(
    metadata: RemoteTrackMetadataInput
): ResolvedRemoteTrackMetadata {
    return {
        title:
            normalizeOptionalString(metadata.title) ?? DEFAULT_REMOTE_TITLE,
        artist:
            normalizeOptionalString(metadata.artist) ?? DEFAULT_REMOTE_ARTIST,
        album:
            normalizeOptionalString(metadata.album) ?? DEFAULT_REMOTE_ALBUM,
        duration:
            normalizeDuration(metadata.duration) ?? DEFAULT_REMOTE_DURATION,
        thumbnailUrl: normalizeOptionalString(metadata.thumbnailUrl),
        isrc: normalizeOptionalString(metadata.isrc),
        quality: normalizeOptionalString(metadata.quality),
        explicit:
            typeof metadata.explicit === "boolean" ? metadata.explicit : undefined,
    };
}

/**
 * Returns true when the provided metadata still looks like a placeholder row
 * that should be repaired from the provider API.
 */
export function hasPlaceholderRemoteTrackMetadata(
    metadata: RemoteTrackMetadataInput
): boolean {
    const title = normalizeOptionalString(metadata.title);
    const artist = normalizeOptionalString(metadata.artist);
    const album = normalizeOptionalString(metadata.album);

    return (
        isPlaceholderValue("title", title) ||
        isPlaceholderValue("artist", artist) ||
        isPlaceholderValue("album", album)
    );
}

/**
 * Resolve request-supplied metadata into a persistable payload, fetching
 * provider details inline when the request only carries placeholder values.
 */
export async function resolveRemoteTrackMetadataForRequest(
    lookup: RemoteTrackLookup
): Promise<ResolvedRemoteTrackMetadata> {
    const resolved = normalizeResolvedMetadata(lookup.metadata);

    if (!hasPlaceholderRemoteTrackMetadata(lookup.metadata)) {
        return resolved;
    }

    try {
        if (lookup.provider === "tidal") {
            const tidalId =
                typeof lookup.tidalId === "number" &&
                Number.isFinite(lookup.tidalId) &&
                lookup.tidalId > 0
                    ? Math.trunc(lookup.tidalId)
                    : null;

            if (!tidalId) {
                return resolved;
            }

            const { tidalStreamingService } = await import("./tidalStreaming");
            const detail = await tidalStreamingService.getTrack(
                lookup.userId,
                tidalId
            );
            if (!detail) {
                return resolved;
            }

            if (!isPlaceholderValue("title", detail.title)) {
                resolved.title = detail.title;
            }
            if (!isPlaceholderValue("artist", detail.artist)) {
                resolved.artist = detail.artist;
            }
            if (!isPlaceholderValue("album", detail.album?.title)) {
                resolved.album = detail.album.title;
            }
            if (normalizeDuration(detail.duration)) {
                resolved.duration = Math.trunc(detail.duration);
            }
            const normalizedIsrc = normalizeOptionalString(detail.isrc);
            if (normalizedIsrc) {
                resolved.isrc = normalizedIsrc;
            }
            if (typeof detail.explicit === "boolean") {
                resolved.explicit = detail.explicit;
            }

            return resolved;
        }

        const videoId = normalizeOptionalString(lookup.videoId);
        if (!videoId) {
            return resolved;
        }

        let song: {
            title?: string;
            artist?: string;
            album?: string;
            duration?: number;
            thumbnails?: unknown[];
        } | null = null;
        const { ytMusicService } = await import("./youtubeMusic");

        try {
            song = await ytMusicService.getSong(lookup.userId, videoId);
        } catch (error) {
            log.debug(
                `Falling back to __public__ YT metadata lookup for videoId=${videoId}`,
                error
            );
        }

        if (!song) {
            song = await ytMusicService.getSong("__public__", videoId);
        }
        if (!song) {
            return resolved;
        }

        const normalizedSongTitle = normalizeOptionalString(song.title);
        if (
            normalizedSongTitle &&
            !isPlaceholderValue("title", normalizedSongTitle)
        ) {
            resolved.title = normalizedSongTitle;
        }
        const normalizedSongArtist = normalizeOptionalString(song.artist);
        if (
            normalizedSongArtist &&
            !isPlaceholderValue("artist", normalizedSongArtist)
        ) {
            resolved.artist = normalizedSongArtist;
        }
        const normalizedSongAlbum = normalizeOptionalString(song.album);
        if (
            normalizedSongAlbum &&
            !isPlaceholderValue("album", normalizedSongAlbum)
        ) {
            resolved.album = normalizedSongAlbum;
        }
        if (normalizeDuration(song.duration)) {
            resolved.duration = Math.trunc(song.duration!);
        }
        if (!resolved.thumbnailUrl) {
            resolved.thumbnailUrl = pickBestThumbnailUrl(song.thumbnails);
        }

        return resolved;
    } catch (error) {
        log.warn(
            `Failed to resolve inline metadata for ${lookup.provider} track`,
            error
        );
        return resolved;
    }
}
