export type TrackRef =
    | { trackId: string }
    | { tidalTrackId: number }
    | { youtubeVideoId: string };

export type AddToPlaylistRef =
    | { trackId: string }
    | {
        tidalTrackId: number;
        title: string;
        artist: string;
        album: string;
        duration: number;
        isrc?: string;
    }
    | {
        youtubeVideoId: string;
        title: string;
        artist: string;
        album: string;
        duration: number;
        thumbnailUrl?: string;
    };

type ProviderSource = "local" | "tidal" | "youtube";

type TrackRefInput = {
    id?: string | null;
    title?: string | null;
    displayTitle?: string | null;
    duration?: number | string | null;
    isrc?: string | null;
    thumbnailUrl?: string | null;
    artist?: {
        name?: string | null;
    } | string | null;
    album?: {
        title?: string | null;
        coverArt?: string | null;
    } | string | null;
    streamSource?: ProviderSource | null;
    tidalTrackId?: number | string | null;
    youtubeVideoId?: string | null;
    provider?: {
        source?: ProviderSource | null;
        tidalTrackId?: number | string | null;
        youtubeVideoId?: string | null;
    } | null;
};

function normalizeTidalTrackId(value: number | string | null | undefined): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const trimmed = value.trim();
        if (/^[1-9]\d*$/.test(trimmed)) {
            const parsed = Number(trimmed);
            if (Number.isSafeInteger(parsed)) {
                return parsed;
            }
        }
    }

    return null;
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function normalizeDuration(value: number | string | null | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }

    return null;
}

function hasRemotePrefix(trackId: string | null | undefined): boolean {
    if (!trackId) return false;
    return trackId.startsWith("yt:") || trackId.startsWith("tidal:");
}

function prefixedTrackIdRef(
    trackId: string | null | undefined
): TrackRef | null {
    if (!trackId) return null;

    if (trackId.startsWith("yt:")) {
        const youtubeVideoId = trackId.slice(3);
        if (youtubeVideoId) {
            return {
                youtubeVideoId,
            };
        }
    }

    if (trackId.startsWith("tidal:")) {
        const tidalTrackId = normalizeTidalTrackId(trackId.slice(6));
        if (tidalTrackId !== null) {
            return {
                tidalTrackId,
            };
        }
    }

    return null;
}

function resolveStreamSource(input: TrackRefInput): ProviderSource | null {
    return input.streamSource ?? input.provider?.source ?? null;
}

function resolveYouTubeVideoId(input: TrackRefInput): string | null {
    const explicit = normalizeNonEmptyString(
        input.youtubeVideoId ?? input.provider?.youtubeVideoId
    );
    if (explicit !== null) {
        return explicit;
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed && "youtubeVideoId" in prefixed) {
        return prefixed.youtubeVideoId;
    }

    return null;
}

function resolveTidalTrackId(input: TrackRefInput): number | null {
    const explicit = normalizeTidalTrackId(
        input.tidalTrackId ?? input.provider?.tidalTrackId
    );
    if (explicit !== null) {
        return explicit;
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed && "tidalTrackId" in prefixed) {
        return prefixed.tidalTrackId;
    }

    return null;
}

/**
 * Returns whether the provided reference shape identifies a non-local provider track.
 */
export function isRemoteTrack(input: TrackRefInput | TrackRef): boolean {
    const streamSource = resolveStreamSource(input as TrackRefInput);
    if (streamSource === "local") {
        return false;
    }

    if ("trackId" in input) {
        return false;
    }

    if ("youtubeVideoId" in input && normalizeNonEmptyString(input.youtubeVideoId) !== null) {
        return true;
    }

    if ("tidalTrackId" in input && normalizeTidalTrackId(input.tidalTrackId) !== null) {
        return true;
    }

    if (hasRemotePrefix((input as TrackRefInput).id)) {
        return true;
    }

    if (resolveYouTubeVideoId(input as TrackRefInput) !== null) {
        return true;
    }

    if (resolveTidalTrackId(input as TrackRefInput) !== null) {
        return true;
    }

    return streamSource === "youtube" || streamSource === "tidal";
}

/**
 * Normalizes mixed track payloads into a strict local/remote track reference union.
 */
export function toTrackRef(input: TrackRefInput): TrackRef {
    const source = resolveStreamSource(input);

    if (source === "local") {
        if (typeof input.id === "string" && input.id.trim()) {
            return {
                trackId: input.id,
            };
        }
        throw new Error("Local track reference is missing track id");
    }

    if (source === "youtube") {
        const youtubeVideoId = resolveYouTubeVideoId(input);
        if (!youtubeVideoId) {
            throw new Error("Remote YouTube track is missing youtubeVideoId");
        }
        return {
            youtubeVideoId,
        };
    }

    if (source === "tidal") {
        const tidalTrackId = resolveTidalTrackId(input);
        if (tidalTrackId === null) {
            throw new Error("Remote TIDAL track is missing tidalTrackId");
        }
        return {
            tidalTrackId,
        };
    }

    const prefixed = prefixedTrackIdRef(input.id);
    if (prefixed) {
        return prefixed;
    }

    const youtubeVideoId = resolveYouTubeVideoId(input);
    if (youtubeVideoId) {
        return {
            youtubeVideoId,
        };
    }

    const tidalTrackId = resolveTidalTrackId(input);
    if (tidalTrackId !== null) {
        return {
            tidalTrackId,
        };
    }

    if (hasRemotePrefix(input.id)) {
        throw new Error("Remote track id prefix is malformed");
    }

    if (typeof input.id === "string" && input.id.trim()) {
        return {
            trackId: input.id,
        };
    }

    throw new Error("Track reference requires a local id or remote provider identifier");
}

function resolveRemoteMetadata(input: TrackRefInput): {
    title: string;
    artist: string;
    album: string;
    duration: number;
} {
    const title = normalizeNonEmptyString(input.title ?? input.displayTitle);
    if (!title) {
        throw new Error("Remote track is missing title metadata");
    }

    let artistName: string | null = null;
    if (typeof input.artist === "string") {
        artistName = normalizeNonEmptyString(input.artist);
    } else {
        artistName = normalizeNonEmptyString(input.artist?.name ?? null);
    }
    if (!artistName) {
        throw new Error("Remote track is missing artist metadata");
    }

    let albumTitle: string | null = null;
    if (typeof input.album === "string") {
        albumTitle = normalizeNonEmptyString(input.album);
    } else {
        albumTitle = normalizeNonEmptyString(input.album?.title ?? null);
    }
    if (!albumTitle) {
        albumTitle = "Single";
    }

    const duration = normalizeDuration(input.duration) ?? 0;

    return {
        title,
        artist: artistName,
        album: albumTitle,
        duration,
    };
}

/**
 * Builds a playlist add payload using provider identifiers and required remote metadata.
 */
export function toAddToPlaylistRef(input: TrackRefInput): AddToPlaylistRef {
    const trackRef = toTrackRef(input);

    if ("trackId" in trackRef) {
        return { trackId: trackRef.trackId };
    }

    const metadata = resolveRemoteMetadata(input);

    if ("tidalTrackId" in trackRef) {
        const isrc = normalizeNonEmptyString(input.isrc);
        if (isrc) {
            return {
                tidalTrackId: trackRef.tidalTrackId,
                ...metadata,
                isrc,
            };
        }

        return {
            tidalTrackId: trackRef.tidalTrackId,
            ...metadata,
        };
    }

    const thumbnailUrl = normalizeNonEmptyString(input.thumbnailUrl);
    if (thumbnailUrl) {
        return {
            youtubeVideoId: trackRef.youtubeVideoId,
            ...metadata,
            thumbnailUrl,
        };
    }

    return {
        youtubeVideoId: trackRef.youtubeVideoId,
        ...metadata,
    };
}
