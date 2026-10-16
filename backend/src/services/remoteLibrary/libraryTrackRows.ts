import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "../../utils/db";
import {
    TRACK_SORT_MAP,
    TRACK_VISIBLE_WHERE,
    trackBrowseWhere,
    type LibraryOriginFilter,
} from "../../utils/librarySorting";

/** Relation graph used to hydrate Library track response rows. */
export const LIBRARY_TRACK_INCLUDE = {
    album: {
        include: {
            artist: { select: { id: true, name: true } },
        },
    },
    federationPeer: {
        select: { id: true, name: true, outboundStatus: true },
    },
} satisfies PrismaTypes.TrackInclude;

/** Track payload hydrated for Library browse responses. */
export type LibraryTrackRow = PrismaTypes.TrackGetPayload<{
    include: typeof LIBRARY_TRACK_INCLUDE;
}>;

function trackPageWhere(
    origin: LibraryOriginFilter,
    albumId: string | undefined,
): PrismaTypes.TrackWhereInput {
    return {
        ...TRACK_VISIBLE_WHERE,
        ...trackBrowseWhere(origin),
        ...(albumId ? { albumId } : {}),
    };
}

function trackPageOrder(sortBy: string, albumId: string | undefined) {
    return albumId
        ? [{ discNo: "asc" as const }, { trackNo: "asc" as const }]
        : (TRACK_SORT_MAP[sortBy] ?? { title: "asc" as const });
}

/** Formats one local or federated row without changing its existing payload. */
export function formatLibraryTrackRow(row: LibraryTrackRow) {
    const { federationPeer, ...track } = row;
    return {
        ...track,
        source: track.origin === "FEDERATED" ? "federated" : "local",
        ...(track.origin === "FEDERATED"
            ? { streamSource: "peer" as const }
            : {}),
        peer: federationPeer
            ? {
                  id: federationPeer.id,
                  name: federationPeer.name,
                  online: federationPeer.outboundStatus === "ACTIVE",
              }
            : undefined,
        album: { ...track.album, coverArt: track.album.coverUrl },
    };
}

/** Loads the unchanged Prisma-backed Library track page. */
export async function loadPrismaLibraryTrackPage(input: {
    origin: LibraryOriginFilter;
    albumId?: string;
    sortBy: string;
    limit: number;
    offset: number;
}) {
    const where = trackPageWhere(input.origin, input.albumId);
    const orderBy = trackPageOrder(input.sortBy, input.albumId);
    const [rows, total] = await Promise.all([
        prisma.track.findMany({
            where,
            skip: input.offset,
            take: input.limit,
            orderBy,
            include: LIBRARY_TRACK_INCLUDE,
        }),
        prisma.track.count({ where }),
    ]);
    return { tracks: rows.map(formatLibraryTrackRow), total };
}
