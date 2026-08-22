import {
    normalizeCanonicalMediaProviderIdentity,
    toAudioEngineSourceType,
    type AudioEngineSourceType,
    type CanonicalMediaProviderIdentity,
    type CanonicalMediaSource,
} from "@soundspan/media-metadata-contract";

/** Provider fields used to resolve the direct playback source. */
export interface RuntimeProviderTrack {
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: "local" | "peer" | "tidal" | "youtube" | "youtube-direct";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    youtubeAudioFormat?: "mp4" | "webm";
}

/** Resolves the next music item eligible for gapless preload. */
export function getNextTrackInfo(
    queue: {
        id: string;
        itemType?: string;
        filePath?: string;
        mediaSource?: CanonicalMediaSource;
        provider?: CanonicalMediaProviderIdentity;
        streamSource?:
            | "local"
            | "peer"
            | "tidal"
            | "youtube"
            | "youtube-direct";
        tidalTrackId?: number;
        youtubeVideoId?: string;
        youtubeAudioFormat?: "mp4" | "webm";
    }[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all",
): {
    id: string;
    itemType?: string;
    filePath?: string;
    mediaSource?: CanonicalMediaSource;
    provider?: CanonicalMediaProviderIdentity;
    streamSource?: "local" | "peer" | "tidal" | "youtube" | "youtube-direct";
    tidalTrackId?: number;
    youtubeVideoId?: string;
    youtubeAudioFormat?: "mp4" | "webm";
} | null {
    if (queue.length === 0) return null;

    let nextIndex: number;
    if (isShuffle) {
        const currentShufflePos = shuffleIndices.indexOf(currentIndex);
        if (currentShufflePos < shuffleIndices.length - 1) {
            nextIndex = shuffleIndices[currentShufflePos + 1];
        } else if (repeatMode === "all") {
            nextIndex = shuffleIndices[0];
        } else {
            return null;
        }
    } else {
        if (currentIndex < queue.length - 1) {
            nextIndex = currentIndex + 1;
        } else if (repeatMode === "all") {
            nextIndex = 0;
        } else {
            return null;
        }
    }

    const nextItem = queue[nextIndex] || null;
    // Mixed-media queue: only music tracks can be preloaded gaplessly.
    if (!nextItem || nextItem.itemType === "episode") return null;
    return nextItem;
}

/** Resolves the direct engine source type from canonical provider metadata. */
export function resolveDirectTrackSourceType(
    track: RuntimeProviderTrack,
): AudioEngineSourceType {
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: track.mediaSource,
        providerTrackId: track.provider?.providerTrackId,
        tidalTrackId: track.provider?.tidalTrackId ?? track.tidalTrackId,
        youtubeVideoId: track.provider?.youtubeVideoId ?? track.youtubeVideoId,
        streamSource: track.streamSource,
    });
    return toAudioEngineSourceType(provider.source);
}

/** Classifies retryable transport and source-availability failures. */
export function isLikelyTransientStreamError(error: unknown): boolean {
    const message = (
        error instanceof Error ? error.message : String(error || "")
    )
        .toLowerCase()
        .trim();
    if (!message) return false;

    return (
        message.includes("network") ||
        message.includes("timeout") ||
        message.includes("aborted") ||
        message.includes("interrupted") ||
        message.includes("socket hang up") ||
        message.includes("connection reset") ||
        message.includes("failed to fetch") ||
        message.includes("media_err_network") ||
        message.includes("not ready") ||
        message.includes("being prepared") ||
        message.includes("temporarily unavailable") ||
        message.includes("source unavailable") ||
        message.includes("503") ||
        message.includes("502") ||
        message.includes("504")
    );
}
