import type { Prisma } from "@prisma/client";
import type { LibraryBrowseOrigin } from "../../utils/librarySorting";

/** Decides whether a Library list needs per-user remote membership. */
export function shouldLoadRemoteLibrary(
    origin: LibraryBrowseOrigin,
    filter: unknown,
): boolean {
    return (
        origin === "remote" ||
        (origin === "all" && (filter === "owned" || filter === "all"))
    );
}

/** Adds remote-only artist ids without replacing existing filter arms. */
export function mergeRemoteArtistWhere(
    where: Prisma.ArtistWhereInput,
    origin: LibraryBrowseOrigin,
    remoteArtistIds: string[],
): Prisma.ArtistWhereInput {
    if (
        origin !== "all" ||
        remoteArtistIds.length === 0 ||
        !Array.isArray(where.OR)
    ) {
        return where;
    }
    return {
        ...where,
        OR: [...where.OR, { id: { in: remoteArtistIds } }],
    };
}

function scopeAlbumWhere(
    where: Prisma.AlbumWhereInput,
    artistId: string | undefined,
): Prisma.AlbumWhereInput {
    if (!artistId) return where;
    if (Array.isArray(where.OR)) {
        return { AND: [{ OR: where.OR }, { artistId }] };
    }
    return { ...where, artistId };
}

/** Merges remote album ids, then applies the optional album-artist scope. */
export function mergeRemoteAlbumWhere(
    where: Prisma.AlbumWhereInput,
    origin: LibraryBrowseOrigin,
    remoteAlbumIds: string[],
    artistId: string | undefined,
): Prisma.AlbumWhereInput {
    const merged =
        origin === "all" && remoteAlbumIds.length > 0
            ? {
                  OR: [
                      where,
                      {
                          location: "REMOTE" as const,
                          id: { in: remoteAlbumIds },
                      },
                  ],
              }
            : where;
    return scopeAlbumWhere(merged, artistId);
}
