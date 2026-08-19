import { config } from "../config";
import type { Quality as StreamingQuality } from "../services/audioStreaming";
import { safeResolvePath } from "./safeResolvePath";

/** Lifetime of a successful in-process audio-info cache entry. */
export const AUDIO_INFO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const AUDIO_INFO_CACHE_MAX_ENTRIES = 2000;

interface AudioInfoResponsePayload {
    codec: string | null;
    bitrate: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    lossless: boolean | null;
    channels: number | null;
}

interface FederatedAudioInfoTrack {
    mime: string | null;
    fileSize: number | null;
    duration: number | null;
}

const AUDIO_CODEC_BY_FORMAT_VALUE: Readonly<Record<string, string>> = {
    mp3: "MP3",
    flac: "FLAC",
    m4a: "AAC",
    aac: "AAC",
    ogg: "OGG",
    opus: "Opus",
    wav: "WAV",
    wma: "WMA",
    ape: "APE",
    wavpack: "WavPack",
    "audio/aac": "AAC",
    "audio/alac": "ALAC",
    "audio/flac": "FLAC",
    "audio/mp3": "MP3",
    "audio/mp4": "AAC",
    "audio/mpeg": "MP3",
    "audio/ogg": "OGG",
    "audio/opus": "Opus",
    "audio/wav": "WAV",
    "audio/webm": "WEBM",
    "audio/x-flac": "FLAC",
    "audio/x-wav": "WAV",
    "application/ogg": "OGG",
};

const LOSSLESS_CODECS = new Set(["FLAC", "ALAC", "WAV", "APE", "WavPack"]);

interface AudioInfoCacheEntry {
    expiresAt: number;
    payload: AudioInfoResponsePayload;
}

/** In-process metadata probe cache shared by library audio-info requests. */
export const audioInfoCache = new Map<string, AudioInfoCacheEntry>();

/** Builds the cache key for source or transcoded playback metadata. */
export const buildAudioInfoCacheKey = (
    trackId: string,
    filePath: string,
    fileModified?: Date | null,
    options: {
        scope?: "source" | "playback";
        quality?: StreamingQuality | null;
    } = {},
): string => {
    const modifiedToken =
        fileModified instanceof Date ? fileModified.toISOString() : "unknown";
    const scope = options.scope ?? "source";
    const quality = options.quality ?? "na";
    return `${trackId}:${scope}:${quality}:${filePath}:${modifiedToken}`;
};

/** Removes expired entries and enforces the audio-info cache size bound. */
export const pruneAudioInfoCache = (now: number) => {
    for (const [key, entry] of audioInfoCache.entries()) {
        if (entry.expiresAt <= now) {
            audioInfoCache.delete(key);
        }
    }

    while (audioInfoCache.size > AUDIO_INFO_CACHE_MAX_ENTRIES) {
        const oldestKey = audioInfoCache.keys().next().value as
            | string
            | undefined;
        if (!oldestKey) break;
        audioInfoCache.delete(oldestKey);
    }
};

/** Normalizes a request value to a supported streaming quality. */
export const normalizeStreamingQuality = (
    value: unknown,
): StreamingQuality | null => {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (
        normalized === "original" ||
        normalized === "high" ||
        normalized === "medium" ||
        normalized === "low"
    ) {
        return normalized;
    }
    return null;
};

/** Builds best-effort audio metadata without exposing peer storage details. */
export const buildFederatedAudioInfo = (
    track: FederatedAudioInfoTrack,
): AudioInfoResponsePayload => {
    const normalizedFormatValue =
        typeof track.mime === "string"
            ? track.mime.split(";", 1)[0].trim().toLowerCase()
            : "";
    const codec = AUDIO_CODEC_BY_FORMAT_VALUE[normalizedFormatValue] ?? null;
    const fileSize = track.fileSize;
    const duration = track.duration;
    const bitrate =
        typeof fileSize === "number" &&
        Number.isFinite(fileSize) &&
        fileSize > 0 &&
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration > 0
            ? Math.round((fileSize * 8) / duration / 1000)
            : null;

    return {
        codec,
        bitrate,
        sampleRate: null,
        bitDepth: null,
        lossless: codec !== null && LOSSLESS_CODECS.has(codec),
        channels: null,
    };
};

/** Resolves a persisted audio path beneath the configured music root. */
export const resolveAudioInfoAbsolutePath = (
    relativeFilePath: string,
): string | null =>
    safeResolvePath(
        config.music.musicPath,
        relativeFilePath.replace(/\\/g, "/"),
    );

/** Reads the source-file metadata returned by the audio-info endpoint. */
export const readAudioInfoPayload = async (
    absolutePath: string,
): Promise<AudioInfoResponsePayload> => {
    const { parseFile } = await import("music-metadata");
    const metadata = await parseFile(absolutePath, {
        duration: false,
        skipCovers: true,
    });
    const fmt = metadata.format;

    return {
        codec: fmt.codec || null,
        bitrate: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null, // kbps
        sampleRate: fmt.sampleRate || null, // Hz
        bitDepth: fmt.bitsPerSample || null, // e.g. 16, 24
        lossless: fmt.lossless ?? null,
        channels: fmt.numberOfChannels || null,
    };
};
