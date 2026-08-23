import { prisma } from "../utils/db";

const DETAIL_TRACK_LIMIT = 1_000;
const ANONYMOUS_OWNER_NAME = "Soundspan user";

const exportEligibility = {
    isPublic: true,
} as const;
const exportedPlaylistItemWhere = {
    trackId: { not: null },
    track: {
        origin: "LOCAL",
        peerId: null,
        removedAt: null,
        album: {
            location: "LIBRARY",
            peerId: null,
            artist: { peerId: null },
        },
    },
} as const;

function displayName(value: string | null): string {
    const normalized = value?.trim();
    return normalized ? normalized : ANONYMOUS_OWNER_NAME;
}

/** Lists one bounded offset page of public playlists. */
export async function getFederationPlaylistPage(input: {
    offset: number;
    limit: number;
}) {
    const rows = await prisma.playlist.findMany({
        where: exportEligibility,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: input.offset,
        take: input.limit + 1,
        select: {
            id: true,
            name: true,
            updatedAt: true,
            user: { select: { displayName: true } },
            _count: {
                select: { items: { where: exportedPlaylistItemWhere } },
            },
        },
    });
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
        playlists: page.map((row) => ({
            remoteId: row.id,
            name: row.name,
            trackCount: row._count.items,
            updatedAt: row.updatedAt.toISOString(),
            owner: { displayName: displayName(row.user.displayName) },
        })),
        nextOffset: hasMore ? input.offset + page.length : null,
    };
}

/** Loads a bounded playlist detail after re-checking publication. */
export async function getFederationPlaylistDetail(remoteId: string) {
    const row = await prisma.playlist.findFirst({
        where: { id: remoteId, ...exportEligibility },
        select: {
            id: true,
            name: true,
            updatedAt: true,
            user: { select: { displayName: true } },
            items: {
                where: exportedPlaylistItemWhere,
                orderBy: { sort: "asc" },
                take: DETAIL_TRACK_LIMIT,
                select: {
                    track: {
                        select: {
                            id: true,
                            title: true,
                            duration: true,
                            album: {
                                select: {
                                    title: true,
                                    artist: { select: { name: true } },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!row) return null;
    return {
        playlist: {
            remoteId: row.id,
            name: row.name,
            owner: { displayName: displayName(row.user.displayName) },
            updatedAt: row.updatedAt.toISOString(),
            tracks: row.items.flatMap(({ track }) =>
                track
                    ? [
                          {
                              remoteTrackId: track.id,
                              title: track.title,
                              artist: track.album.artist.name,
                              album: track.album.title,
                              duration: track.duration,
                          },
                      ]
                    : [],
            ),
        },
    };
}
