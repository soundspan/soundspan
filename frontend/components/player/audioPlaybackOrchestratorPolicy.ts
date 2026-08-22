/**
 * Resolves the playback duration to display, choosing between the audio
 * engine's reported duration and the known metadata duration.
 *
 * For remote streams delivered as fragmented MP4 (e.g. TIDAL HI_RES_LOSSLESS),
 * the `<audio>` element may report only a single fragment's duration (~4 s)
 * instead of the full track length.  When the loaded duration is less than
 * half the metadata duration for a remote stream, the metadata value is more
 * trustworthy.
 */
export function resolvePlaybackDuration(input: {
    loadedDurationSec: number;
    metadataDurationSec: number;
    isRemoteStream: boolean;
}): number {
    const loaded = input.loadedDurationSec;
    const metadata = Math.max(0, input.metadataDurationSec);

    // Invalid loaded values → use metadata
    if (typeof loaded !== "number" || !Number.isFinite(loaded) || loaded <= 0) {
        return metadata;
    }

    // For remote streams, if the audio element reports less than half the
    // metadata duration it's likely reading a single fMP4 fragment.
    if (input.isRemoteStream && metadata > 0 && loaded < metadata * 0.5) {
        return metadata;
    }

    return loaded || metadata;
}

/**
 * Resolves the Howler format hint for a remote stream source.
 *
 * Howler requires a format hint (or file extension in the URL) to pass its
 * internal codec compatibility check before loading. Remote stream URLs are
 * extensionless, so we must provide an explicit hint.
 *
 * The hint only gates Howler's `codecs()` check — it does NOT affect the
 * browser's actual decoding. In HTML5 mode the browser reads Content-Type
 * from the response; in Web Audio mode `decodeAudioData` decodes based on
 * binary content. So "mp4" safely passes the gate for both AAC and FLAC
 * content.
 */
export function resolveRemoteStreamFormat(
    streamSource: "local" | "tidal" | "youtube" | string | undefined | null,
): string | undefined {
    if (streamSource === "tidal" || streamSource === "youtube") {
        return "mp4";
    }
    return undefined;
}

/**
 * Executes shouldAttemptRecoveryOnUnexpectedPause.
 */
export function shouldAttemptRecoveryOnUnexpectedPause(
    bufferedAheadSec: number | null,
    maxBufferedAheadSec: number,
): boolean {
    return (
        typeof bufferedAheadSec === "number" &&
        Number.isFinite(bufferedAheadSec) &&
        bufferedAheadSec <= maxBufferedAheadSec
    );
}

/**
 * Decides whether a track load should autoplay from local playing state.
 *
 * A Listen Together FOLLOWER's playback starts are owned by the LT
 * protocol: the server's synchronized play-at (and playback deltas)
 * call resume() explicitly after the ready gate. Local wasPlaying
 * leaking into the load autoplayed a fraction of track-start audio
 * before the gate paused it — an audible blip on every follower track
 * change (GH #42 soak finding). Hosts and solo playback keep the
 * existing local-state autoplay.
 */
export function resolveLoadAutoplayDecision(input: {
    wasPlayingBeforeLoad: boolean;
    isListenTogetherFollower: boolean;
    hasAdvancePlayIntent?: boolean;
}): boolean {
    if (input.isListenTogetherFollower) {
        return false;
    }
    return input.wasPlayingBeforeLoad || Boolean(input.hasAdvancePlayIntent);
}

/**
 * Validity window for a queue-advance play intent. Generous enough to
 * cover the async advance paths (auto-match-vibe request before next())
 * yet bounded so a stalled advance can't autoplay an unrelated load
 * minutes later.
 */
export const ADVANCE_PLAY_INTENT_TTL_MS = 30_000;

/**
 * A track-end auto-advance DECLARES that the next load must play; it is
 * never inferred from transient UI playing state. Under the native
 * engine the element's `pause` fires before `ended`, so by load time
 * both the isPlaying mirror ref and engine.isPlaying() can read false —
 * the advance would land paused (GH #53). The intent is a timestamp
 * stamped when the end handler advances the queue and consumed by the
 * next load.
 */
export function isAdvancePlayIntentFresh(
    intentAtMs: number | null,
    nowMs: number,
): boolean {
    if (intentAtMs === null || !Number.isFinite(intentAtMs)) {
        return false;
    }
    const ageMs = nowMs - intentAtMs;
    return ageMs >= 0 && ageMs < ADVANCE_PLAY_INTENT_TTL_MS;
}

/**
 * Resolves the engine format hint for a track load or preload.
 *
 * TIDAL/YT Music remote streams get the extensionless-URL hint; direct
 * YouTube audio reports its container; peer streams get NO hint because
 * the body may be the peer's original container or provider bytes from
 * the stream-time fallback ladder, and the engine detects the container
 * from Content-Type when the hint is absent; local tracks derive the
 * hint from the file extension.
 */
export function resolveTrackFormatHint(
    track: {
        streamSource?: string | null;
        youtubeAudioFormat?: "mp4" | "webm";
        filePath?: string | null;
    } | null,
): string | undefined {
    if (!track) return "mp3";
    if (track.streamSource === "youtube-direct") {
        return track.youtubeAudioFormat === "webm" ? "webm" : "mp4";
    }
    if (track.streamSource === "tidal" || track.streamSource === "youtube") {
        return resolveRemoteStreamFormat(track.streamSource);
    }
    if (track.streamSource === "peer") {
        return undefined;
    }
    const ext = (track.filePath || "").split(".").pop()?.toLowerCase();
    if (ext === "flac") return "flac";
    if (ext === "m4a" || ext === "aac") return "mp4";
    if (ext === "ogg" || ext === "opus") return "webm";
    if (ext === "wav") return "wav";
    return "mp3";
}
