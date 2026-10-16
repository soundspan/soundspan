import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import {
    LIBRARY_SURFACE_ALBUM_LOCATIONS,
    TRACK_VISIBLE_WHERE,
    trackBrowseWhere,
} from "../../utils/librarySorting";
import {
    VISIBLE_TRACK_SQL,
    trackBrowseSql,
} from "../../utils/libraryRadioPredicates";
import { toLibraryRemoteTrack } from "./responseRow";
import {
    formatLibraryTrackRow,
    LIBRARY_TRACK_INCLUDE,
} from "./libraryTrackRows";
import { hydrateRemoteLibraryTracks } from "./remoteDisplayHydration";
import type { RemoteLibrarySet, RemoteLibraryTrack } from "./types";

type SongsPageOrigin = "all" | "remote";
type SongsPageKind = "local" | "tidal" | "youtube";
type SongsIdRow = { kind: SongsPageKind; id: string; title: string };
type HydratedSong =
    | ReturnType<typeof formatLibraryTrackRow>
    | ReturnType<typeof toLibraryRemoteTrack>;
const SORT_DIRECTIONS = {
    name: Prisma.raw("ASC"),
    "name-desc": Prisma.raw("DESC"),
} as const;

/** Resolves the SQL title direction using the Prisma path's fallback. */
export function resolveSongsSortDirection(sortBy: string): Prisma.Sql {
    return (
        SORT_DIRECTIONS[sortBy as keyof typeof SORT_DIRECTIONS] ??
        SORT_DIRECTIONS.name
    );
}

function buildLocalArm(origin: SongsPageOrigin): Prisma.Sql[] {
    if (origin === "remote") return [];
    return [
        Prisma.sql`SELECT ${"local"}::text AS kind, t.id, t.title
            FROM "Track" t
            JOIN "Album" a ON a.id = t."albumId"
            WHERE ${VISIBLE_TRACK_SQL}
              AND a.location = ANY(${[...LIBRARY_SURFACE_ALBUM_LOCATIONS]}::"AlbumLocation"[])
              AND ${trackBrowseSql("t", "all")}`,
    ];
}

/** Builds the parameterized cross-table ID page used by Songs browsing. */
export function buildLibrarySongsIdPageQuery(input: {
    origin: SongsPageOrigin;
    tidalIds: string[];
    youtubeIds: string[];
    sortBy: string;
    limit: number;
    offset: number;
}): Prisma.Sql {
    const arms = [
        ...buildLocalArm(input.origin),
        Prisma.sql`SELECT ${"tidal"}::text AS kind, tt.id, tt.title
            FROM "TrackTidal" tt
            WHERE tt.id = ANY(${input.tidalIds}::text[])`,
        Prisma.sql`SELECT ${"youtube"}::text AS kind, yt.id, yt.title
            FROM "TrackYtMusic" yt
            WHERE yt.id = ANY(${input.youtubeIds}::text[])`,
    ];
    const direction = resolveSongsSortDirection(input.sortBy);
    return Prisma.sql`${Prisma.join(arms, " UNION ALL ")}
        ORDER BY title ${direction}, kind ASC, id ASC
        LIMIT ${input.limit} OFFSET ${input.offset}`;
}

function providerRowIds(remoteLibrary: RemoteLibrarySet) {
    return {
        tidalIds: remoteLibrary.tracks
            .filter((row) => row.provider === "tidal")
            .map((row) => row.providerRowId),
        youtubeIds: remoteLibrary.tracks
            .filter((row) => row.provider === "youtube")
            .map((row) => row.providerRowId),
    };
}

async function hydrateSongsPage(
    idPage: SongsIdRow[],
    localWhere: Prisma.TrackWhereInput,
    remoteLibrary: RemoteLibrarySet,
) {
    const localIds = idPage
        .filter((row) => row.kind === "local")
        .map((row) => row.id);
    const selectedRemoteRows = remoteRowsForPage(idPage, remoteLibrary);
    const [localRows, hydratedRemoteRows] = await Promise.all([
        loadLocalRows(localIds, localWhere),
        hydrateRemoteLibraryTracks(selectedRemoteRows),
    ]);
    const localById = new Map(
        localRows.map((row) => [`local:${row.id}`, formatLibraryTrackRow(row)]),
    );
    const remoteById = new Map(
        hydratedRemoteRows.map((row) => [remoteRowKey(row), row]),
    );
    return idPage.flatMap<HydratedSong>((row) => {
        const key = `${row.kind}:${row.id}`;
        const localTrack = localById.get(key);
        if (localTrack) return [localTrack];
        const remoteRow = remoteById.get(key);
        return remoteRow ? [toLibraryRemoteTrack(remoteRow)] : [];
    });
}

function remoteRowsForPage(
    idPage: SongsIdRow[],
    remoteLibrary: RemoteLibrarySet,
) {
    const selectedKeys = new Set(
        idPage
            .filter((row) => row.kind !== "local")
            .map((row) => `${row.kind}:${row.id}`),
    );
    return remoteLibrary.tracks.filter((row) =>
        selectedKeys.has(remoteRowKey(row)),
    );
}

function remoteRowKey(
    row: Pick<RemoteLibraryTrack, "provider" | "providerRowId">,
): string {
    return `${row.provider}:${row.providerRowId}`;
}

async function loadLocalRows(ids: string[], where: Prisma.TrackWhereInput) {
    if (ids.length === 0) return [];
    return prisma.track.findMany({
        where: { ...where, id: { in: ids } },
        include: LIBRARY_TRACK_INCLUDE,
    });
}

/** Loads one deterministic page across visible Track and remote provider rows. */
export async function loadLibrarySongsPage(input: {
    origin: SongsPageOrigin;
    remoteLibrary: RemoteLibrarySet;
    sortBy: string;
    limit: number;
    offset: number;
}) {
    const providerIds = providerRowIds(input.remoteLibrary);
    const localWhere = {
        ...TRACK_VISIBLE_WHERE,
        ...trackBrowseWhere("all"),
    };
    const [idPage, localTotal] = await Promise.all([
        prisma.$queryRaw<SongsIdRow[]>(
            buildLibrarySongsIdPageQuery({ ...input, ...providerIds }),
        ),
        input.origin === "all"
            ? prisma.track.count({ where: localWhere })
            : Promise.resolve(0),
    ]);
    const tracks = await hydrateSongsPage(
        idPage,
        localWhere,
        input.remoteLibrary,
    );
    return {
        tracks,
        total: localTotal + input.remoteLibrary.tracks.length,
    };
}
