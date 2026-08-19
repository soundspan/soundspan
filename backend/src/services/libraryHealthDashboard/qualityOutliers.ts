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

/** Lossy MIME values defined by the repository audio-streaming MIME map. */
export const LOSSY_AUDIO_MIMES = [
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/opus",
] as const;

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
            mime: { in: [...LOSSY_AUDIO_MIMES] },
        },
        select: {
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
