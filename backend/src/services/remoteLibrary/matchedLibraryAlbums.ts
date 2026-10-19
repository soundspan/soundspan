import { chunkArray } from "../../utils/async";
import { prisma } from "../../utils/db";
import {
    TRACK_VISIBLE_WHERE,
    trackBrowseWhere,
} from "../../utils/librarySorting";

const RELEASE_GROUP_QUERY_CHUNK_SIZE = 1_000;

/**
 * Finds matched release groups represented by visible local library tracks.
 *
 * @throws The Prisma query failure when the lookup cannot complete.
 */
export async function findLibraryHeldReleaseGroups(
    rgMbids: readonly string[],
): Promise<Set<string>> {
    const uniqueRgMbids = [
        ...new Set(rgMbids.filter((rgMbid) => rgMbid.trim().length > 0)),
    ];
    const heldRgMbids = new Set<string>();
    for (const chunk of chunkArray(
        uniqueRgMbids,
        RELEASE_GROUP_QUERY_CHUNK_SIZE,
    )) {
        const albums = await prisma.album.findMany({
            where: {
                location: "LIBRARY",
                rgMbid: { in: chunk },
                tracks: {
                    some: {
                        ...TRACK_VISIBLE_WHERE,
                        ...trackBrowseWhere("local"),
                    },
                },
            },
            select: { rgMbid: true },
        });
        for (const album of albums) heldRgMbids.add(album.rgMbid);
    }
    return heldRgMbids;
}
