import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { textTerms, titleMatchRank } from "./remoteDisplayHydration";
import type { RemoteLibraryProvider, RemoteLibrarySet } from "./types";

const REMOTE_ALBUM_SEARCH_FETCH_CAP = 200;
const titleCollator = new Intl.Collator("en", { sensitivity: "base" });
const remoteAlbumSelect = {
    id: true,
    title: true,
    year: true,
    coverUrl: true,
    artistId: true,
    artist: { select: { id: true, name: true } },
} satisfies Prisma.AlbumSelect;

type RemoteAlbumRow = Prisma.AlbumGetPayload<{
    select: typeof remoteAlbumSelect;
}>;

/** Album row returned by the per-user remote search group. */
export interface RemoteSearchAlbum {
    id: string;
    title: string;
    artistId: string;
    year: number | null;
    coverUrl: string | null;
    source: "remote";
    remoteSources: RemoteLibraryProvider[];
    artist: { id: string; name: string; mbid: "" };
}

function compareRemoteAlbums(
    normalizedQuery: string,
    left: RemoteAlbumRow,
    right: RemoteAlbumRow,
): number {
    const rankDelta =
        titleMatchRank(left.title, normalizedQuery) -
        titleMatchRank(right.title, normalizedQuery);
    if (rankDelta !== 0) return rankDelta;
    const titleDelta = titleCollator.compare(left.title, right.title);
    if (titleDelta !== 0) return titleDelta;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
}

function toRemoteSearchAlbum(
    row: RemoteAlbumRow,
    remoteSources: RemoteLibraryProvider[],
): RemoteSearchAlbum {
    return {
        id: row.id,
        title: row.title,
        artistId: row.artistId,
        year: row.year,
        coverUrl: row.coverUrl,
        source: "remote",
        remoteSources,
        artist: { id: row.artistId, name: row.artist.name, mbid: "" },
    };
}

function albumTextWhere(terms: ReadonlyArray<string>) {
    return terms.map((term) => ({
        OR: [
            { title: { contains: term, mode: "insensitive" as const } },
            {
                artist: {
                    name: { contains: term, mode: "insensitive" as const },
                },
            },
        ],
    }));
}

/** Searches one user's remote-only album candidates and ranks the matches. */
export async function searchRemoteLibraryAlbums(
    remoteLibrary: RemoteLibrarySet,
    query: string,
    limit: number,
): Promise<RemoteSearchAlbum[]> {
    const candidateIds = [...remoteLibrary.byAlbumId.keys()];
    const terms = textTerms(query);
    if (candidateIds.length === 0 || terms.length === 0 || limit < 1) return [];
    const rows = await prisma.album.findMany({
        where: {
            id: { in: candidateIds },
            location: "REMOTE",
            AND: albumTextWhere(terms),
        },
        select: remoteAlbumSelect,
        take: REMOTE_ALBUM_SEARCH_FETCH_CAP,
    });
    const normalizedQuery = query.trim().toLocaleLowerCase("en");
    return [...rows]
        .sort((left, right) =>
            compareRemoteAlbums(normalizedQuery, left, right),
        )
        .slice(0, limit)
        .flatMap((row) => {
            const sources = remoteLibrary.byAlbumId.get(row.id);
            return sources ? [toRemoteSearchAlbum(row, sources)] : [];
        });
}
