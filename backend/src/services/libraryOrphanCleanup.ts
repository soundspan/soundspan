import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const cleanupLogger = logger.child("LibraryOrphanCleanup");

/** Counts of catalog parents deleted after their last track was purged. */
export interface LibraryOrphanCleanupResult {
    albumsDeleted: number;
    artistsDeleted: number;
}

/** Deletes albums without track rows, then artists without album rows. */
export async function cleanupOrphanedLibraryEntities(): Promise<LibraryOrphanCleanupResult> {
    const orphanedAlbums = await prisma.album.findMany({
        where: { tracks: { none: {} } },
        select: { id: true },
    });
    const albumsDeleted =
        orphanedAlbums.length > 0
            ? (
                  await prisma.album.deleteMany({
                      where: {
                          id: { in: orphanedAlbums.map((album) => album.id) },
                          tracks: { none: {} },
                      },
                  })
              ).count
            : 0;

    const orphanedArtists = await prisma.artist.findMany({
        where: { albums: { none: {} } },
        select: { id: true },
    });
    const artistsDeleted =
        orphanedArtists.length > 0
            ? (
                  await prisma.artist.deleteMany({
                      where: {
                          id: {
                              in: orphanedArtists.map((artist) => artist.id),
                          },
                          albums: { none: {} },
                      },
                  })
              ).count
            : 0;

    if (albumsDeleted > 0 || artistsDeleted > 0) {
        cleanupLogger.info(
            `Deleted ${albumsDeleted} orphaned albums and ${artistsDeleted} orphaned artists`,
        );
    }
    return {
        albumsDeleted,
        artistsDeleted,
    };
}
