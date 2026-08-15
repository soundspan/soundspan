/** Version identifier for the central media metadata contract. */
export const CENTRAL_MEDIA_METADATA_CONTRACT_VERSION = "1.0.0";

/** Complete runtime list of canonical media source identifiers. */
export const CANONICAL_MEDIA_SOURCE_VALUES = [
    "local",
    "tidal",
    "youtube",
    "youtube-direct",
] as const;

/** Canonical source identifier shared across media metadata consumers. */
export type CanonicalMediaSource =
    (typeof CANONICAL_MEDIA_SOURCE_VALUES)[number];

/** Non-local media sources backed by remote providers. */
export type RemoteMediaSource = Exclude<CanonicalMediaSource, "local">;

/** Media sources a queue item can be resolved to for playback. "youtube-direct" is a container/transport variant of "youtube", never an independent resolution target, so it is intentionally excluded. */
export type ResolvedMediaSource = Exclude<
    CanonicalMediaSource,
    "youtube-direct"
>;

/** Canonical sources supported by segmented streaming sessions. */
export type SegmentedStreamingSourceType = Extract<
    CanonicalMediaSource,
    "local"
>;

/** Source identifiers accepted by the audio engine boundary. */
export type AudioEngineSourceType = "local" | "tidal" | "ytmusic";

/** Canonical provider identity and optional provider-specific track metadata. */
export interface CanonicalMediaProviderIdentity {
    source: CanonicalMediaSource;
    providerTrackId?: string;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    /** Audio container served for "youtube-direct" streams (webm for opus, mp4 for AAC). */
    youtubeAudioFormat?: "mp4" | "webm";
}

/** Legacy provider fields retained for compatibility with existing stream payloads. */
export interface LegacyStreamFields {
    streamSource?: RemoteMediaSource;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    /** Audio container hint carried for "youtube-direct" streams only. */
    youtubeAudioFormat?: "mp4" | "webm";
}

/** Normalized search result returned by remote media providers. */
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

/** Media types currently understood by federation v1 consumers. */
export type FederationMediaType =
    | "artist"
    | "album"
    | "track"
    | "podcast"
    | "audiobook";

/** Source discriminator emitted by unified track response serializers. */
export type UnifiedTrackSource = "local" | "tidal" | "youtube" | "federated";

/** Safe peer provenance attached to a federated unified track response. */
export interface FederatedTrackPeer {
    id: string;
    name: string;
    online: boolean;
}

/** Optional analyzer metadata carried by federation track envelopes. */
export interface FederationTrackAudioFeatures {
    bpm?: number | null;
    beatsCount?: number | null;
    key?: string | null;
    keyScale?: string | null;
    keyStrength?: number | null;
    energy?: number | null;
    loudness?: number | null;
    dynamicRange?: number | null;
    danceability?: number | null;
    valence?: number | null;
    arousal?: number | null;
    instrumentalness?: number | null;
    acousticness?: number | null;
    speechiness?: number | null;
    moodHappy?: number | null;
    moodSad?: number | null;
    moodRelaxed?: number | null;
    moodAggressive?: number | null;
    moodParty?: number | null;
    moodAcoustic?: number | null;
    moodElectronic?: number | null;
    danceabilityMl?: number | null;
    moodTags?: string[] | null;
    essentiaGenres?: string[] | null;
    lastfmTags?: string[] | null;
}

/** Track-specific attributes published by the additive federation v1 envelope. */
export interface FederationTrackAttributes extends FederationTrackAudioFeatures {
    title: string;
    discNo: number;
    trackNo: number;
    duration: number;
    mime: string | null;
    fileSize: number;
    recordingMbid: string | null;
    isrc: string | null;
    audioHash: string | null;
    embedding?: number[];
}

/** Podcast catalog-listing attributes published by federation hosts. */
export interface FederationPodcastAttributes {
    feedUrl: string;
    title: string;
    author: string | null;
    description: string | null;
    imageUrl: string | null;
    itunesId: string | null;
}

/** Audiobook mirror attributes published by federation hosts. */
export interface FederationAudiobookAttributes {
    title: string;
    author: string | null;
    narrator: string | null;
    duration: number | null;
    description: string | null;
    asin: string | null;
    isbn: string | null;
    coverUrl: boolean;
}

/** Generic additive federation catalog envelope shared by hosts and consumers. */
export interface FederationMediaItemEnvelope<
    Attributes extends Record<string, unknown> = Record<string, unknown>,
> {
    id: string;
    mediaType: FederationMediaType;
    updatedAt: Date | string;
    parentRef?: string;
    attributes: Attributes;
}

/** Deleted catalog identity emitted by the federation delta feed. */
export interface FederationCatalogTombstone {
    entityType: FederationMediaType;
    entityId: string;
    deletedAt: Date | string;
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

/** Normalizes a source identifier, mapping legacy YT Music naming to YouTube and returning null for invalid values. */
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

/** Resolves explicit or inferred media metadata to a canonical source, returning local when no valid remote source can be determined. */
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

/** Normalizes provider metadata into a canonical identity, falling back to a local identity when the input has no valid remote source. */
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

/** Converts a canonical provider identity into compatible legacy stream fields. */
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

/** Maps a canonical media source to the source identifier used by the audio engine. */
export const toAudioEngineSourceType = (
    source: CanonicalMediaSource,
): AudioEngineSourceType => {
    if (source === "youtube" || source === "youtube-direct") {
        return "ytmusic";
    }
    return source;
};
