import type { Prisma } from "@prisma/client";

/** Shared predicate for user-facing reads of tracks that still exist. */
export const TRACK_VISIBLE_WHERE = {
    removedAt: null,
} satisfies Prisma.TrackWhereInput;

/** Shared predicate for tracks physically owned by this soundspan instance. */
export const LOCAL_TRACK_WHERE = {
    origin: "LOCAL",
} satisfies Prisma.TrackWhereInput;

/** Origin values accepted by browse and search read surfaces. */
export const LIBRARY_ORIGIN_VALUES = ["all", "local", "peers"] as const;
export type LibraryOriginFilter = (typeof LIBRARY_ORIGIN_VALUES)[number];

/** Parses a read-surface origin value without accepting arrays or aliases. */
export function parseLibraryOrigin(value: unknown): LibraryOriginFilter | null {
    if (value === undefined) return "all";
    return typeof value === "string" &&
        LIBRARY_ORIGIN_VALUES.includes(value as LibraryOriginFilter)
        ? (value as LibraryOriginFilter)
        : null;
}

/**
 * Builds browse visibility for one origin. Federated rows linked to a local
 * duplicate stay materialized for fallback streaming but never render twice.
 */
export function trackBrowseWhere(
    origin: LibraryOriginFilter = "all",
): Prisma.TrackWhereInput {
    if (origin === "local") return { ...LOCAL_TRACK_WHERE };
    const visibleFederated = {
        origin: "FEDERATED" as const,
        OR: [
            { dedupOfTrackId: null },
            { federationPeer: { showDedupedCopies: true } },
            { dedupOfTrack: { removedAt: { not: null } } },
        ],
    } satisfies Prisma.TrackWhereInput;
    if (origin === "peers") {
        return visibleFederated;
    }
    return {
        OR: [{ ...LOCAL_TRACK_WHERE }, visibleFederated],
    };
}

/** Shared origin and dedup predicate that composes with caller-owned `OR` arms. */
export const TRACK_BROWSE_WHERE = {
    AND: [trackBrowseWhere()],
} satisfies Prisma.TrackWhereInput;

/** Supported artist-list sort expressions keyed by the public query value. */
export const ARTIST_SORT_MAP: Record<
    string,
    Prisma.ArtistOrderByWithRelationInput
> = {
    name: { name: "asc" as const },
    "name-desc": { name: "desc" as const },
    tracks: { totalTrackCount: "desc" as const },
};

/** Supported album-list sort expressions keyed by the public query value. */
export const ALBUM_SORT_MAP: Record<
    string,
    Prisma.AlbumOrderByWithRelationInput
> = {
    name: { title: "asc" as const },
    "name-desc": { title: "desc" as const },
    recent: { year: "desc" as const },
};

/** Supported track-list sort expressions keyed by the public query value. */
export const TRACK_SORT_MAP: Record<
    string,
    Prisma.TrackOrderByWithRelationInput
> = {
    name: { title: "asc" as const },
    "name-desc": { title: "desc" as const },
};
