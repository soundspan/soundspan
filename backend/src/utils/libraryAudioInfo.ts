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

interface NormalizedAudioCodec {
    codec: string | null;
    lossless: boolean;
}

const MAX_AUDIO_FORMAT_VALUE_LENGTH = 256;
const UNKNOWN_AUDIO_CODEC: NormalizedAudioCodec = {
    codec: null,
    lossless: false,
};
const MP3_CODEC = { codec: "MP3", lossless: false } as const;
const AAC_CODEC = { codec: "AAC", lossless: false } as const;
const ALAC_CODEC = { codec: "ALAC", lossless: true } as const;
const VORBIS_CODEC = { codec: "Vorbis", lossless: false } as const;
const OPUS_CODEC = { codec: "Opus", lossless: false } as const;
const FLAC_CODEC = { codec: "FLAC", lossless: true } as const;
const PCM_CODEC = { codec: "PCM", lossless: true } as const;
const WAV_CODEC = { codec: "WAV", lossless: true } as const;
const APE_CODEC = { codec: "APE", lossless: true } as const;
const WAVPACK_CODEC = { codec: "WavPack", lossless: true } as const;
const DSD_CODEC = { codec: "DSD", lossless: true } as const;
const WMA_CODEC = { codec: "WMA", lossless: false } as const;

// music-metadata@11.14.0 parser labels plus scanner extension and legacy MIME labels.
const AUDIO_CODEC_BY_FORMAT_VALUE = new Map<string, NormalizedAudioCodec>([
    ["mp3", MP3_CODEC],
    ["mpeg 1 layer 3", MP3_CODEC],
    ["mpeg-1 layer 3", MP3_CODEC],
    ["m4a", AAC_CODEC],
    ["aac", AAC_CODEC],
    ["mpeg-4/aac", AAC_CODEC],
    ["adts/mpeg-4", AAC_CODEC],
    ["alac", ALAC_CODEC],
    ["ogg", { codec: "OGG", lossless: false }],
    ["vorbis i", VORBIS_CODEC],
    ["opus", OPUS_CODEC],
    ["flac", FLAC_CODEC],
    ["wav", WAV_CODEC],
    ["wave", WAV_CODEC],
    ["pcm", PCM_CODEC],
    ["ape", APE_CODEC],
    ["monkey's audio", APE_CODEC],
    ["wavpack", WAVPACK_CODEC],
    ["dsd", DSD_CODEC],
    ["wma", WMA_CODEC],
    ["asf/audio", WMA_CODEC],
    ["audio/aac", AAC_CODEC],
    ["audio/alac", ALAC_CODEC],
    ["audio/flac", FLAC_CODEC],
    ["audio/mp3", MP3_CODEC],
    ["audio/mp4", AAC_CODEC],
    // Real MP3s persist a parser layer label or the scanner's "MP3" extension label.
    ["audio/mpeg", UNKNOWN_AUDIO_CODEC],
    ["audio/ogg", { codec: "OGG", lossless: false }],
    ["audio/opus", OPUS_CODEC],
    ["audio/wav", WAV_CODEC],
    ["audio/webm", { codec: "WEBM", lossless: false }],
    ["audio/x-flac", FLAC_CODEC],
    ["audio/x-wav", WAV_CODEC],
    ["application/ogg", { codec: "OGG", lossless: false }],
]);

function inferAudioCodec(normalized: string): NormalizedAudioCodec | null {
    if (normalized.includes("flac")) return FLAC_CODEC;
    if (normalized.includes("alac")) return ALAC_CODEC;
    if (normalized.includes("aac")) return AAC_CODEC;
    if (normalized.includes("vorbis")) return VORBIS_CODEC;
    if (normalized.includes("opus")) return OPUS_CODEC;
    if (normalized.includes("wavpack")) return WAVPACK_CODEC;
    if (normalized.includes("monkey")) return APE_CODEC;
    if (normalized.includes("dsd")) return DSD_CODEC;
    if (normalized.includes("windows media audio") || normalized.includes("wma")) {
        return normalized.includes("lossless")
            ? { codec: "WMA", lossless: true }
            : WMA_CODEC;
    }
    if (
        normalized.includes("layer 3") ||
        (normalized.includes("mpeg") && normalized.includes("layer"))
    ) {
        return MP3_CODEC;
    }
    if (normalized.includes("mp3")) return MP3_CODEC;
    if (normalized.includes("pcm") && !normalized.includes("adpcm")) {
        return PCM_CODEC;
    }
    if (normalized.includes("wave")) return WAV_CODEC;
    if (normalized.includes("ogg")) return { codec: "OGG", lossless: false };
    return null;
}

function normalizeAudioCodec(value: unknown): NormalizedAudioCodec {
    if (typeof value !== "string" || value.length > MAX_AUDIO_FORMAT_VALUE_LENGTH) {
        return UNKNOWN_AUDIO_CODEC;
    }
    const normalized = value.split(";", 1)[0].trim().toLowerCase();
    if (!normalized) return UNKNOWN_AUDIO_CODEC;
    return (
        AUDIO_CODEC_BY_FORMAT_VALUE.get(normalized) ??
        inferAudioCodec(normalized) ??
        UNKNOWN_AUDIO_CODEC
    );
}

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
    const audioCodec = normalizeAudioCodec(track.mime);
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
        codec: audioCodec.codec,
        bitrate,
        sampleRate: null,
        bitDepth: null,
        lossless: audioCodec.lossless,
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
