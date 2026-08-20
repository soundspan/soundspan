import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

/** Deletes an artist after locking its catalog albums in global lock order. */
export async function deleteArtistCatalogEntry(
    artistId: string,
): Promise<void> {
    await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "Album"
            WHERE "artistId" = ${artistId}
            ORDER BY "id"
            FOR UPDATE
        `);
        await transaction.artist.delete({ where: { id: artistId } });
    });
}
