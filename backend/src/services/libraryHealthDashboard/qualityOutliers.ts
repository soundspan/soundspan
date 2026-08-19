import { prisma } from "../../utils/db";
import {
    normalizePagination,
    type LibraryHealthPagination,
} from "./pagination";
import { VISIBLE_LOCAL_TRACK_WHERE } from "./predicates";
import {
    deriveBitrateKbps,
    LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT,
} from "./storageAnalytics";

const LOSSLESS_CODEC_TOKENS = new Set([
    "flac",
    "alac",
    "pcm",
    "wav",
    "wave",
    "wav-pcm",
    "aiff",
    "ape",
    "monkey's",
    "wavpack",
    "wavpack4",
    "dsd",
    "tak",
    "tta",
    "tta1",
    "ieee",
    "ieee_float",
    "float",
    "lossless",
    "mlp",
    "ralf",
    "truehd",
]);
const LOSSY_CODEC_TOKENS = new Set([
    "mp3",
    "mp4",
    "m4a",
    "aac",
    "opus",
    "vorbis",
    "ogg",
    "wma",
    "speex",
    "alaw",
    "ulaw",
    "µlaw",
    "mulaw",
    "a-law",
    "u-law",
    "purevoice",
    "ac3",
    "ac-3",
    "eac3",
    "dts",
    "dts2",
    "mpeg",
    "mpeglayer3",
    "mp4s",
    "adpcm",
    "dvi_adpcm",
    "gsm610",
    "mpeg_adts_aac",
    "mpeg_loas",
    "raw_aac1",
    "dolby_ac3_spdif",
    "dvm",
    "raw_sport",
    "esst_ac3",
    "drm",
    "14_4",
    "28_8",
    "at1",
    "atrc",
    "cook",
    "sipr",
    "qdmc",
    "qdm2",
]);
const MACE_LOSSY_PATTERN = /(?:^|\s)mace\s+(?:3|6):1(?:$|[\s+])/i;
const IMA_LOSSY_PATTERN = /(?:^|\s)ima\s+4:1(?:$|[\s+])/i;
const WINDOWS_MEDIA_AUDIO_PATTERN = /^windows media audio(?:\b|$)/i;

function tokenizeCodecLabel(value: string): string[] {
    return value.split(/[\s/+,;()[\]]+/u).filter((token) => token.length > 0);
}

/** Classifies scanner codec labels and legacy MIME values without guessing unknowns. */
export function isLossyAudioCodec(value: string | null): boolean {
    if (value === null) return false;
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) return false;
    // The scanner reserves this legacy fallback for genuinely unknown formats.
    if (normalized === "audio/mpeg") return false;
    const tokens = tokenizeCodecLabel(normalized);
    const hasLosslessToken = tokens.some((token) =>
        LOSSLESS_CODEC_TOKENS.has(token),
    );
    const hasLossyToken =
        tokens.some((token) => LOSSY_CODEC_TOKENS.has(token)) ||
        MACE_LOSSY_PATTERN.test(normalized) ||
        IMA_LOSSY_PATTERN.test(normalized) ||
        WINDOWS_MEDIA_AUDIO_PATTERN.test(normalized);
    // The dashboard is report-only. Exclude ambiguous mixed labels instead of
    // presenting a file with any lossless stream as definitively lossy.
    // music-metadata 11 reports hybrid (lossy) WavPack as PCM, so it remains
    // indistinguishable from common lossless WavPack on this report-only surface.
    if (hasLosslessToken && hasLossyToken) return false;
    return hasLossyToken;
}

export interface LossyAlbumQuality {
    albumId: string;
    title: string;
    artist: { id: string; name: string };
    averageBitrateKbps: number;
    trackCount: number;
}

export interface LossyAlbumQualityStats {
    albums: LossyAlbumQuality[];
    sampledTracks: number;
    sampleLimit: number;
    isTruncated: boolean;
}

function reduceAlbumQuality(
    rows: Array<{
        mime: string | null;
        fileSize: number;
        duration: number | null;
        album: {
            id: string;
            title: string;
            artist: { id: string; name: string };
        };
    }>,
): LossyAlbumQuality[] {
    const grouped = new Map<
        string,
        { album: (typeof rows)[number]["album"]; sum: number; count: number }
    >();
    for (const row of rows) {
        if (!isLossyAudioCodec(row.mime)) continue;
        const bitrate = deriveBitrateKbps(row.fileSize, row.duration);
        if (bitrate === null) continue;
        const current = grouped.get(row.album.id) ?? {
            album: row.album,
            sum: 0,
            count: 0,
        };
        current.sum += bitrate;
        current.count += 1;
        grouped.set(row.album.id, current);
    }
    return [...grouped.values()].map(({ album, sum, count }) => ({
        albumId: album.id,
        title: album.title,
        artist: album.artist,
        averageBitrateKbps: Math.round((sum / count) * 10) / 10,
        trackCount: count,
    }));
}

/** Loads bounded per-album bitrate statistics for lossy local tracks. */
export async function loadLossyAlbumQualityStats(): Promise<LossyAlbumQualityStats> {
    const loadedRows = await prisma.track.findMany({
        where: {
            ...VISIBLE_LOCAL_TRACK_WHERE,
        },
        select: {
            mime: true,
            fileSize: true,
            duration: true,
            album: {
                select: {
                    id: true,
                    title: true,
                    artist: { select: { id: true, name: true } },
                },
            },
        },
        orderBy: { id: "asc" },
        take: LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT + 1,
    });
    const isTruncated = loadedRows.length > LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT;
    const rows = loadedRows.slice(0, LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT);
    return {
        albums: reduceAlbumQuality(rows),
        sampledTracks: rows.length,
        sampleLimit: LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT,
        isTruncated,
    };
}

/** Filters and paginates cached per-album lossy bitrate statistics. */
export function getQualityOutliers(
    stats: LossyAlbumQualityStats,
    floorKbps: number,
    pagination: LibraryHealthPagination,
) {
    const page = normalizePagination(pagination);
    const outliers = stats.albums
        .filter((album) => album.averageBitrateKbps < floorKbps)
        .sort(
            (left, right) =>
                left.averageBitrateKbps - right.averageBitrateKbps ||
                left.title.localeCompare(right.title),
        );
    return {
        floorKbps,
        items: outliers.slice(page.offset, page.offset + page.limit),
        total: outliers.length,
        ...page,
        sampledTracks: stats.sampledTracks,
        sampleLimit: stats.sampleLimit,
        isTruncated: stats.isTruncated,
    };
}
