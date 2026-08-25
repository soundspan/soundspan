import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "../../utils/db";
import { LIBRARY_TRACK_WHERE, SUBSONIC_ALBUM_LOCATION_WHERE } from "./shared";

/** Builds the Prisma membership predicate mirrored by SQL genre paging. */
export function buildSongsByGenreWhere(
    genre: string,
): PrismaTypes.TrackWhereInput {
    return {
        ...LIBRARY_TRACK_WHERE,
        album: { location: SUBSONIC_ALBUM_LOCATION_WHERE },
        trackGenres: {
            some: {
                genre: {
                    name: { equals: genre, mode: "insensitive" },
                },
            },
        },
    };
}

function validatePageArguments(
    genre: string,
    dayKey: string,
    count: number,
    offset: number,
): void {
    if (genre.trim().length === 0) throw new TypeError("Genre is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
        throw new TypeError("Genre page day key must use YYYY-MM-DD");
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > 500) {
        throw new RangeError("Genre page count must be from 0 through 500");
    }
    if (Number.isFinite(offset) && (!Number.isInteger(offset) || offset < 0)) {
        throw new RangeError(
            "Genre page offset must be a non-negative integer",
        );
    }
}

/** Returns one stable, parameter-bound SQL page of matching track IDs. */
export async function loadSongsByGenrePageIds(
    genre: string,
    dayKey: string,
    count: number,
    offset: number,
): Promise<string[]> {
    validatePageArguments(genre, dayKey, count, offset);
    if (!Number.isSafeInteger(offset)) return [];
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT track.id
        FROM "Track" AS track
        INNER JOIN "Album" AS album ON album.id = track."albumId"
        WHERE track."removedAt" IS NULL
          AND album.location IN ('LIBRARY', 'FEDERATED')
          AND (
              track.origin = 'LOCAL'
              OR (
                  track.origin = 'FEDERATED'
                  AND (
                      track."dedupOfTrackId" IS NULL
                      OR EXISTS (
                          SELECT 1
                          FROM "FederationPeer" AS peer
                          WHERE peer.id = track."peerId"
                            AND peer."showDedupedCopies" = true
                      )
                      OR EXISTS (
                          SELECT 1
                          FROM "Track" AS dedup
                          WHERE dedup.id = track."dedupOfTrackId"
                            AND dedup."removedAt" IS NOT NULL
                      )
                  )
              )
          )
          AND EXISTS (
              SELECT 1
              FROM "TrackGenre" AS track_genre
              INNER JOIN "Genre" AS genre_row
                  ON genre_row.id = track_genre."genreId"
              WHERE track_genre."trackId" = track.id
                AND LOWER(genre_row.name) = LOWER(${genre})
          )
        ORDER BY hashtext(track.id || ${dayKey}), track.id
        LIMIT ${count} OFFSET ${offset}
    `);
    return rows.map((row) => row.id);
}
