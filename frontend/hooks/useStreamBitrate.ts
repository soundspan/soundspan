import { useState, useEffect } from "react";
import { useAudioState } from "@/lib/audio-context";
import { api } from "@/lib/api";

// ── TIDAL stream quality info ──────────────────────────────────────

export interface TidalStreamQuality {
    /** Quality tier: HIGH, LOSSLESS, HI_RES_LOSSLESS, etc. */
    quality: string;
    /** Codec: AAC, FLAC, etc. */
    codec: string;
    /** Bit depth (e.g. 16, 24) — only for lossless+ */
    bitDepth?: number;
    /** Sample rate in Hz (e.g. 44100, 96000) — only for lossless+ */
    sampleRate?: number;
}

// ── Local track quality info ───────────────────────────────────────

export interface LocalTrackQuality {
    /** Codec name: FLAC, MPEG 1 Layer 3, AAC, Vorbis, etc. */
    codec: string;
    /** Bitrate in kbps (meaningful for lossy; variable for lossless) */
    bitrate: number | null;
    /** Sample rate in Hz (e.g. 44100, 96000) */
    sampleRate: number | null;
    /** Bit depth (e.g. 16, 24, 32) */
    bitDepth: number | null;
    /** Whether the format is lossless */
    lossless: boolean;
}

/** Map raw music-metadata codec names to short friendly labels */
const CODEC_FRIENDLY_NAMES: Record<string, string> = {
    "MPEG 1 Layer 3": "MP3",
    "MPEG 2 Layer 3": "MP3",
    "MPEG 2.5 Layer 3": "MP3",
    "MPEG 4/ISO/AVC": "AAC",
    "Vorbis": "OGG",
    "Opus": "Opus",
    "ALAC": "ALAC",
    "FLAC": "FLAC",
    "PCM": "WAV",
    "WMA": "WMA",
    "DSD": "DSD",
};

// Shared across all hook instances so Mini/Full players do not duplicate requests.
const ytInfoCache = new Map<string, { abr: number; acodec: string }>();
const ytInfoInFlight = new Map<string, Promise<{ abr: number; acodec: string }>>();
const tidalInfoCache = new Map<number, TidalStreamQuality>();
const tidalInfoInFlight = new Map<number, Promise<TidalStreamQuality>>();
const localInfoCache = new Map<string, LocalTrackQuality>();
const localInfoInFlight = new Map<string, Promise<LocalTrackQuality>>();

function fetchYtStreamInfo(videoId: string): Promise<{ abr: number; acodec: string }> {
    const cached = ytInfoCache.get(videoId);
    if (cached) return Promise.resolve(cached);

    const inFlight = ytInfoInFlight.get(videoId);
    if (inFlight) return inFlight;

    const request = api
        .getYtMusicStreamInfo(videoId)
        .then((info) => {
            const normalized = {
                abr: info.abr,
                acodec: info.acodec,
            };
            ytInfoCache.set(videoId, normalized);
            return normalized;
        })
        .finally(() => {
            ytInfoInFlight.delete(videoId);
        });

    ytInfoInFlight.set(videoId, request);
    return request;
}

function fetchTidalStreamInfo(trackId: number): Promise<TidalStreamQuality> {
    const cached = tidalInfoCache.get(trackId);
    if (cached) return Promise.resolve(cached);

    const inFlight = tidalInfoInFlight.get(trackId);
    if (inFlight) return inFlight;

    const request = api
        .getTidalStreamInfo(trackId)
        .then((info) => {
            const normalized: TidalStreamQuality = {
                quality: info.quality,
                codec: info.acodec,
                bitDepth: info.bit_depth,
                sampleRate: info.sample_rate,
            };
            tidalInfoCache.set(trackId, normalized);
            return normalized;
        })
        .finally(() => {
            tidalInfoInFlight.delete(trackId);
        });

    tidalInfoInFlight.set(trackId, request);
    return request;
}

function fetchLocalTrackQuality(trackId: string): Promise<LocalTrackQuality> {
    const cached = localInfoCache.get(trackId);
    if (cached) return Promise.resolve(cached);

    const inFlight = localInfoInFlight.get(trackId);
    if (inFlight) return inFlight;

    const request = api
        .getLocalTrackAudioInfo(trackId)
        .then((info) => {
            const normalized: LocalTrackQuality = {
                codec: info.codec || "Unknown",
                bitrate: info.bitrate,
                sampleRate: info.sampleRate,
                bitDepth: info.bitDepth,
                lossless: info.lossless ?? false,
            };
            localInfoCache.set(trackId, normalized);
            return normalized;
        })
        .finally(() => {
            localInfoInFlight.delete(trackId);
        });

    localInfoInFlight.set(trackId, request);
    return request;
}

export function friendlyCodecName(raw: string): string {
    return CODEC_FRIENDLY_NAMES[raw] || raw;
}

export function formatSampleRateKHz(hz?: number | null): string | null {
    if (!hz || !Number.isFinite(hz) || hz <= 0) return null;
    const khz = hz / 1000;
    const label = Number.isInteger(khz) ? khz.toString() : khz.toFixed(1).replace(/\.0$/, "");
    return `${label}kHz`;
}

function normalizeCodecLabel(raw?: string | null): string | null {
    if (!raw) return null;
    const normalized = raw.trim();
    if (!normalized) return null;
    return friendlyCodecName(normalized).toUpperCase();
}

function isLikelyLosslessTidal(quality: TidalStreamQuality): boolean {
    if (quality.bitDepth && quality.sampleRate) return true;
    if (/LOSSLESS/i.test(quality.quality || "")) return true;
    const codec = normalizeCodecLabel(quality.codec);
    return codec === "FLAC" || codec === "ALAC" || codec === "WAV" || codec === "PCM";
}

function estimateTidalLossyBitrateKbps(qualityTier?: string): number | null {
    const tier = (qualityTier || "").toUpperCase();
    if (tier === "LOW") return 96;
    if (tier === "MEDIUM") return 160;
    if (tier === "HIGH") return 320;
    return null;
}

export function formatTidalQualityBadge(quality?: TidalStreamQuality | null): string | null {
    if (!quality) return null;
    const codec = normalizeCodecLabel(quality.codec);
    const codecPart = codec ? ` · ${codec}` : "";

    if (isLikelyLosslessTidal(quality)) {
        const sampleRate = formatSampleRateKHz(quality.sampleRate);
        if (sampleRate) {
            return `TIDAL${codecPart} · ${quality.bitDepth || "?"}/${sampleRate}`;
        }
        return `TIDAL${codecPart}`;
    }

    const bitrate = estimateTidalLossyBitrateKbps(quality.quality);
    if (bitrate) {
        return `TIDAL${codecPart} · ${bitrate} kbps`;
    }
    return `TIDAL${codecPart}`;
}

export function formatLocalQualityBadge(quality?: LocalTrackQuality | null): string | null {
    if (!quality) return null;
    const codec = normalizeCodecLabel(quality.codec);
    const codecLabel = codec || "UNKNOWN";

    if (quality.lossless) {
        const sampleRate = formatSampleRateKHz(quality.sampleRate);
        if (sampleRate) {
            return `${codecLabel} · ${quality.bitDepth || "?"}/${sampleRate}`;
        }
        return codecLabel;
    }

    if (quality.bitrate && quality.bitrate > 0) {
        return `${codecLabel} · ${quality.bitrate} kbps`;
    }
    return codecLabel;
}

export function formatYtQualityBadge(codec?: string | null, bitrate?: number | null): string {
    const codecLabel = normalizeCodecLabel(codec);
    const bitrateLabel = bitrate && bitrate > 0 ? `${bitrate} kbps` : null;

    if (codecLabel && bitrateLabel) return `YT MUSIC · ${codecLabel} · ${bitrateLabel}`;
    if (codecLabel) return `YT MUSIC · ${codecLabel}`;
    if (bitrateLabel) return `YT MUSIC · ${bitrateLabel}`;
    return "YT MUSIC";
}

/**
 * Returns audio quality metadata for the currently playing track:
 *   - YouTube Music: bitrate (kbps) + codec
 *   - TIDAL: quality tier + codec + bit depth / sample rate
 *   - Local: codec + bitrate / bit depth / sample rate
 *
 * Fetches info from the backend the first time a track starts
 * playing and caches results so repeat plays don't trigger extra
 * requests.
 */
export function useStreamBitrate(): {
    bitrate: number | null;
    codec: string | null;
    tidalQuality: TidalStreamQuality | null;
    localQuality: LocalTrackQuality | null;
} {
    const { currentTrack, playbackType } = useAudioState();
    const [bitrate, setBitrate] = useState<number | null>(null);
    const [codec, setCodec] = useState<string | null>(null);
    const [tidalQuality, setTidalQuality] = useState<TidalStreamQuality | null>(null);
    const [localQuality, setLocalQuality] = useState<LocalTrackQuality | null>(null);

    // ── YouTube Music stream info ──────────────────────────────────
    useEffect(() => {
        if (
            playbackType !== "track" ||
            !currentTrack ||
            currentTrack.streamSource !== "youtube" ||
            !currentTrack.youtubeVideoId
        ) {
            setBitrate(null);
            setCodec(null);
            return;
        }

        const videoId = currentTrack.youtubeVideoId;
        let cancelled = false;

        fetchYtStreamInfo(videoId)
            .then((info) => {
                if (cancelled) return;
                setBitrate(info.abr);
                setCodec(info.acodec);
            })
            .catch(() => {
                if (!cancelled) {
                    setBitrate(null);
                    setCodec(null);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [currentTrack, playbackType]);

    // ── TIDAL stream info ──────────────────────────────────────────
    useEffect(() => {
        if (
            playbackType !== "track" ||
            !currentTrack ||
            currentTrack.streamSource !== "tidal" ||
            !currentTrack.tidalTrackId
        ) {
            setTidalQuality(null);
            return;
        }

        const trackId = currentTrack.tidalTrackId;
        let cancelled = false;

        fetchTidalStreamInfo(trackId)
            .then((quality) => {
                if (cancelled) return;
                setTidalQuality(quality);
            })
            .catch(() => {
                if (!cancelled) setTidalQuality(null);
            });

        return () => {
            cancelled = true;
        };
    }, [currentTrack, playbackType]);

    // ── Local track quality info ───────────────────────────────────
    useEffect(() => {
        // Local tracks have no streamSource (or streamSource === "local")
        // and always have an id that isn't a synthetic lastfm-* id
        const isLocal =
            playbackType === "track" &&
            currentTrack &&
            !currentTrack.streamSource &&
            currentTrack.id &&
            !currentTrack.id.startsWith("lastfm-");

        if (!isLocal) {
            setLocalQuality(null);
            return;
        }

        const trackId = currentTrack!.id;
        let cancelled = false;

        fetchLocalTrackQuality(trackId)
            .then((quality) => {
                if (cancelled) return;
                setLocalQuality(quality);
            })
            .catch(() => {
                if (!cancelled) setLocalQuality(null);
            });

        return () => {
            cancelled = true;
        };
    }, [currentTrack, playbackType]);

    return { bitrate, codec, tidalQuality, localQuality };
}
