import type { Prisma } from "@prisma/client";

/** Shared predicate for user-facing reads of tracks that still exist. */
export const TRACK_VISIBLE_WHERE = {
    removedAt: null,
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
