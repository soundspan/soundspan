export const CENTRAL_MEDIA_METADATA_CONTRACT_VERSION = "1.0.0";

export const CANONICAL_MEDIA_SOURCE_VALUES = [
    "local",
    "tidal",
    "youtube",
    "youtube-direct",
] as const;

export type CanonicalMediaSource = (typeof CANONICAL_MEDIA_SOURCE_VALUES)[number];

export type SegmentedStreamingSourceType = Extract<CanonicalMediaSource, "local">;

export type AudioEngineSourceType = "local" | "tidal" | "ytmusic";

export interface CanonicalMediaProviderIdentity {
    source: CanonicalMediaSource;
    providerTrackId?: string;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    /** Audio container served for "youtube-direct" streams (webm for opus, mp4 for AAC). */
    youtubeAudioFormat?: "mp4" | "webm";
}

export interface LegacyStreamFields {
    streamSource?: "tidal" | "youtube" | "youtube-direct";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    /** Audio container hint carried for "youtube-direct" streams only. */
    youtubeAudioFormat?: "mp4" | "webm";
}

export interface CanonicalMediaSearchResult {
    source: Exclude<CanonicalMediaSource, "local">;
    provider: "tidal" | "ytmusic";
    providerTrackId: string;
    title: string;
    artistName: string;
    albumTitle: string | null;
    durationSec: number | null;
    thumbnailUrl: string | null;
    raw: Record<string, unknown>;
}

const normalizeString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const normalizePositiveFiniteNumber = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return value;
};

const normalizeYoutubeAudioFormat = (
    value: unknown,
): "mp4" | "webm" | undefined => {
    if (value === "mp4" || value === "webm") {
        return value;
    }
    return undefined;
};

export const normalizeCanonicalMediaSource = (
    value: unknown,
): CanonicalMediaSource | null => {
    if (
        value === "local" ||
        value === "tidal" ||
        value === "youtube" ||
        value === "youtube-direct"
    ) {
        return value;
    }
    if (value === "ytmusic") {
        return "youtube";
    }
    return null;
};

export const resolveCanonicalMediaSource = (value: {
    mediaSource?: unknown;
    streamSource?: unknown;
    sourceType?: unknown;
    tidalTrackId?: unknown;
    youtubeVideoId?: unknown;
}): CanonicalMediaSource => {
    const source =
        normalizeCanonicalMediaSource(value.mediaSource) ??
        normalizeCanonicalMediaSource(value.streamSource) ??
        normalizeCanonicalMediaSource(value.sourceType);
    if (source) {
        return source;
    }
    if (normalizePositiveFiniteNumber(value.tidalTrackId) !== undefined) {
        return "tidal";
    }
    if (normalizeString(value.youtubeVideoId)) {
        return "youtube";
    }
    return "local";
};

export const normalizeCanonicalMediaProviderIdentity = (value: {
    mediaSource?: unknown;
    streamSource?: unknown;
    sourceType?: unknown;
    providerTrackId?: unknown;
    tidalTrackId?: unknown;
    youtubeVideoId?: unknown;
    youtubeAudioFormat?: unknown;
}): CanonicalMediaProviderIdentity => {
    const source = resolveCanonicalMediaSource(value);
    const providerTrackId = normalizeString(value.providerTrackId);
    const tidalTrackId = normalizePositiveFiniteNumber(value.tidalTrackId);
    const youtubeVideoId = normalizeString(value.youtubeVideoId);

    if (source === "tidal") {
        return {
            source,
            providerTrackId:
                providerTrackId ??
                (tidalTrackId !== undefined
                    ? String(Math.trunc(tidalTrackId))
                    : undefined),
            tidalTrackId,
        };
    }

    if (source === "youtube") {
        return {
            source,
            providerTrackId: providerTrackId ?? youtubeVideoId,
            youtubeVideoId,
        };
    }

    if (source === "youtube-direct") {
        return {
            source,
            providerTrackId: providerTrackId ?? youtubeVideoId,
            youtubeVideoId,
            youtubeAudioFormat: normalizeYoutubeAudioFormat(
                value.youtubeAudioFormat,
            ),
        };
    }

    return { source: "local" };
};

export const toLegacyStreamFields = (
    provider: CanonicalMediaProviderIdentity | null | undefined,
): LegacyStreamFields => {
    if (!provider) {
        return {};
    }
    if (provider.source === "tidal") {
        return {
            streamSource: "tidal",
            tidalTrackId: provider.tidalTrackId,
        };
    }
    if (provider.source === "youtube") {
        return {
            streamSource: "youtube",
            youtubeVideoId: provider.youtubeVideoId,
        };
    }
    if (provider.source === "youtube-direct") {
        return {
            streamSource: "youtube-direct",
            youtubeVideoId: provider.youtubeVideoId,
            youtubeAudioFormat: provider.youtubeAudioFormat,
        };
    }
    return {};
};

export const toAudioEngineSourceType = (
    source: CanonicalMediaSource,
): AudioEngineSourceType => {
    if (source === "youtube" || source === "youtube-direct") {
        return "ytmusic";
    }
    return source;
};
