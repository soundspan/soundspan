import { prisma } from "../../utils/db";
import { VISIBLE_LOCAL_TRACK_WHERE } from "./predicates";

/** Maximum tracks reduced in memory for ratios Prisma cannot aggregate. */
export const LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT = 100_000;

interface StorageTrackRow {
    mime: string | null;
    fileSize: number;
    duration: number | null;
    album: { artist: { id: string; name: string } };
}

/** Derives decimal kilobits per second, rejecting missing or invalid duration. */
export function deriveBitrateKbps(
    fileSize: number,
    duration: number | null,
): number | null {
    if (!Number.isFinite(fileSize) || fileSize < 0) return null;
    if (duration === null || !Number.isFinite(duration) || duration <= 0) {
        return null;
    }
    return (fileSize * 8) / duration / 1_000;
}

function formatBitrateSamples(rows: readonly StorageTrackRow[]) {
    const samples = new Map<string | null, { sum: number; count: number }>();
    for (const row of rows) {
        const bitrate = deriveBitrateKbps(row.fileSize, row.duration);
        if (bitrate === null) continue;
        const current = samples.get(row.mime) ?? { sum: 0, count: 0 };
        current.sum += bitrate;
        current.count += 1;
        samples.set(row.mime, current);
    }
    return samples;
}

function topStorageArtists(rows: readonly StorageTrackRow[]) {
    const artists = new Map<
        string,
        {
            artistId: string;
            artistName: string;
            trackCount: number;
            totalFileSize: number;
        }
    >();
    for (const row of rows) {
        const artist = row.album.artist;
        const current = artists.get(artist.id) ?? {
            artistId: artist.id,
            artistName: artist.name,
            trackCount: 0,
            totalFileSize: 0,
        };
        current.trackCount += 1;
        current.totalFileSize += row.fileSize;
        artists.set(artist.id, current);
    }
    return [...artists.values()]
        .sort(
            (left, right) =>
                right.totalFileSize - left.totalFileSize ||
                left.artistName.localeCompare(right.artistName),
        )
        .slice(0, 25);
}

/** Loads MIME totals and bounded derived storage analytics. */
export async function loadStorageAnalytics() {
    const [groups, loadedRows] = await Promise.all([
        prisma.track.groupBy({
            by: ["mime"],
            where: VISIBLE_LOCAL_TRACK_WHERE,
            _count: { _all: true },
            _sum: { fileSize: true },
            orderBy: { mime: "asc" },
        }),
        prisma.track.findMany({
            where: VISIBLE_LOCAL_TRACK_WHERE,
            select: {
                mime: true,
                fileSize: true,
                duration: true,
                album: {
                    select: { artist: { select: { id: true, name: true } } },
                },
            },
            orderBy: { id: "asc" },
            take: LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT + 1,
        }),
    ]);
    const isTruncated = loadedRows.length > LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT;
    const rows = loadedRows.slice(0, LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT);
    const bitrateSamples = formatBitrateSamples(rows);
    const formats = groups.map((group) => {
        const sample = bitrateSamples.get(group.mime);
        return {
            mime: group.mime,
            trackCount: group._count._all,
            totalFileSize: group._sum.fileSize ?? 0,
            averageBitrateKbps: sample
                ? Math.round((sample.sum / sample.count) * 10) / 10
                : null,
            bitrateSampleSize: sample?.count ?? 0,
        };
    });
    return {
        formats,
        topArtists: topStorageArtists(rows),
        sampledTracks: rows.length,
        sampleLimit: LIBRARY_HEALTH_TRACK_SAMPLE_LIMIT,
        isTruncated,
    };
}
