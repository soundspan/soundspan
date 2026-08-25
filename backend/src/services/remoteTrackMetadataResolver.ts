import { logger } from "../utils/logger";
import type { MappingProvider } from "./remoteProviders/types";

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
const ALBUM_PLACEHOLDERS = new Set(["", "single", "unknown", "unknown album"]);

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
    provider: MappingProvider;
    userId: string;
    tidalId?: number;
    videoId?: string;
    /** Allow a persisted enrichment request to fetch provider artwork. */
    fetchArtworkIfMissing?: boolean;
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
    value: string | undefined,
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
                : undefined,
        )
        .filter((url): url is string => typeof url === "string");

    return urls.at(-1);
}

function normalizeResolvedMetadata(
    metadata: RemoteTrackMetadataInput,
): ResolvedRemoteTrackMetadata {
    return {
        title: normalizeOptionalString(metadata.title) ?? DEFAULT_REMOTE_TITLE,
        artist:
            normalizeOptionalString(metadata.artist) ?? DEFAULT_REMOTE_ARTIST,
        album: normalizeOptionalString(metadata.album) ?? DEFAULT_REMOTE_ALBUM,
        duration:
            normalizeDuration(metadata.duration) ?? DEFAULT_REMOTE_DURATION,
        thumbnailUrl: normalizeOptionalString(metadata.thumbnailUrl),
        isrc: normalizeOptionalString(metadata.isrc),
        quality: normalizeOptionalString(metadata.quality),
        explicit:
            typeof metadata.explicit === "boolean"
                ? metadata.explicit
                : undefined,
    };
}

/**
 * Returns true when the provided metadata still looks like a placeholder row
 * that should be repaired from the provider API.
 */
export function hasPlaceholderRemoteTrackMetadata(
    metadata: RemoteTrackMetadataInput,
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

async function resolveTidalMetadata(
    lookup: RemoteTrackLookup,
    resolved: ResolvedRemoteTrackMetadata,
): Promise<ResolvedRemoteTrackMetadata> {
    const tidalId =
        typeof lookup.tidalId === "number" &&
        Number.isFinite(lookup.tidalId) &&
        lookup.tidalId > 0
            ? Math.trunc(lookup.tidalId)
            : null;
    if (!tidalId) return resolved;

    const { tidalStreamingService } = await import("./tidalStreaming");
    const detail = await tidalStreamingService.getTrack(lookup.userId, tidalId);
    if (!detail) return resolved;

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
    resolved.thumbnailUrl =
        normalizeOptionalString(detail.thumbnailUrl) ?? resolved.thumbnailUrl;
    resolved.isrc = normalizeOptionalString(detail.isrc) ?? resolved.isrc;
    if (typeof detail.explicit === "boolean") {
        resolved.explicit = detail.explicit;
    }
    return resolved;
}

type YtMetadataSong = {
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    thumbnails?: unknown[];
};

async function fetchYtMetadataSong(
    userId: string,
    videoId: string,
): Promise<YtMetadataSong | null> {
    const { ytMusicService } = await import("./youtubeMusic");
    let song: YtMetadataSong | null = null;
    try {
        song = await ytMusicService.getSong(userId, videoId);
    } catch (error) {
        log.debug(
            `Falling back to __public__ YT metadata lookup for videoId=${videoId}`,
            error,
        );
    }
    return song ?? ytMusicService.getSong("__public__", videoId);
}

function applyYtMetadata(
    resolved: ResolvedRemoteTrackMetadata,
    song: YtMetadataSong,
): ResolvedRemoteTrackMetadata {
    const title = normalizeOptionalString(song.title);
    const artist = normalizeOptionalString(song.artist);
    const album = normalizeOptionalString(song.album);
    if (title && !isPlaceholderValue("title", title)) {
        resolved.title = title;
    }
    if (artist && !isPlaceholderValue("artist", artist)) {
        resolved.artist = artist;
    }
    if (album && !isPlaceholderValue("album", album)) {
        resolved.album = album;
    }
    if (normalizeDuration(song.duration)) {
        resolved.duration = Math.trunc(song.duration!);
    }
    resolved.thumbnailUrl =
        resolved.thumbnailUrl ?? pickBestThumbnailUrl(song.thumbnails);
    return resolved;
}

async function resolveYtMetadata(
    lookup: RemoteTrackLookup,
    resolved: ResolvedRemoteTrackMetadata,
): Promise<ResolvedRemoteTrackMetadata> {
    const videoId = normalizeOptionalString(lookup.videoId);
    if (!videoId) return resolved;
    const song = await fetchYtMetadataSong(lookup.userId, videoId);
    return song ? applyYtMetadata(resolved, song) : resolved;
}

/**
 * Resolve request metadata into a persistable payload. Provider detail I/O is
 * limited to placeholder repair or an explicit persisted-artwork enrichment.
 */
export async function resolveRemoteTrackMetadataForRequest(
    lookup: RemoteTrackLookup,
): Promise<ResolvedRemoteTrackMetadata> {
    const resolved = normalizeResolvedMetadata(lookup.metadata);

    const needsMetadataRepair = hasPlaceholderRemoteTrackMetadata(
        lookup.metadata,
    );
    const needsArtworkRepair =
        lookup.fetchArtworkIfMissing === true && !resolved.thumbnailUrl;

    if (!needsMetadataRepair && !needsArtworkRepair) {
        return resolved;
    }

    try {
        if (lookup.provider === "tidal") {
            return await resolveTidalMetadata(lookup, resolved);
        }
        return await resolveYtMetadata(lookup, resolved);
    } catch (error) {
        log.warn(
            `Failed to resolve inline metadata for ${lookup.provider} track`,
            error,
        );
        return resolved;
    }
}
