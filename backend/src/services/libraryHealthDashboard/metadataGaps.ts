import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import {
    normalizePagination,
    type LibraryHealthPagination,
} from "./pagination";
import { VISIBLE_LOCAL_TRACK_WHERE } from "./predicates";

/** Metadata gap names exposed by the admin API. */
export const METADATA_GAP_KINDS = [
    "missing-art",
    "missing-mbid",
    "missing-genres",
    "missing-lyrics",
] as const;
export type MetadataGapKind = (typeof METADATA_GAP_KINDS)[number];

const MISSING_ART_ALBUM_WHERE = {
    location: "LIBRARY",
    coverUrl: null,
    userCoverUrl: null,
} satisfies Prisma.AlbumWhereInput;
const MISSING_ART_ARTIST_WHERE = {
    heroUrl: null,
    userHeroUrl: null,
    albums: { some: { location: "LIBRARY" } },
} satisfies Prisma.ArtistWhereInput;
const MISSING_MBID_ARTIST_WHERE = {
    albums: { some: { location: "LIBRARY" } },
    AND: [
        { mbid: { startsWith: "temp-" } },
        { NOT: { mbid: { startsWith: "temp-remote-" } } },
    ],
} satisfies Prisma.ArtistWhereInput;
const MISSING_MBID_ALBUM_WHERE = {
    location: "LIBRARY",
    AND: [
        { rgMbid: { startsWith: "temp-" } },
        { NOT: { rgMbid: { startsWith: "remote:" } } },
    ],
} satisfies Prisma.AlbumWhereInput;
const MISSING_GENRES_WHERE = {
    ...VISIBLE_LOCAL_TRACK_WHERE,
    essentiaGenres: { isEmpty: true },
    trackGenres: { none: {} },
} satisfies Prisma.TrackWhereInput;
const MISSING_LYRICS_WHERE = {
    ...VISIBLE_LOCAL_TRACK_WHERE,
    OR: [{ lyrics: null }, { lyrics: { source: "none" } }],
} satisfies Prisma.TrackWhereInput;

const ALBUM_SELECT = {
    id: true,
    title: true,
    rgMbid: true,
    coverUrl: true,
    userCoverUrl: true,
    artist: { select: { id: true, name: true } },
} as const;
const TRACK_SELECT = {
    id: true,
    title: true,
    filePath: true,
    album: { select: { title: true, artist: { select: { name: true } } } },
} as const;

/** Returns all dashboard metadata-gap counts without drill-down rows. */
export async function getMetadataGapSummary() {
    const [artAlbums, artArtists, mbidAlbums, mbidArtists, genres, lyrics] =
        await Promise.all([
            prisma.album.count({ where: MISSING_ART_ALBUM_WHERE }),
            prisma.artist.count({ where: MISSING_ART_ARTIST_WHERE }),
            prisma.album.count({ where: MISSING_MBID_ALBUM_WHERE }),
            prisma.artist.count({ where: MISSING_MBID_ARTIST_WHERE }),
            prisma.track.count({ where: MISSING_GENRES_WHERE }),
            prisma.track.count({ where: MISSING_LYRICS_WHERE }),
        ]);
    return {
        missingArt: { albums: artAlbums, artists: artArtists },
        missingMbid: { albums: mbidAlbums, artists: mbidArtists },
        missingGenres: genres,
        missingLyrics: lyrics,
    };
}

async function listAlbumGap(
    kind: "missing-art" | "missing-mbid",
    where: Prisma.AlbumWhereInput,
    artistWhere: Prisma.ArtistWhereInput,
    pagination: LibraryHealthPagination,
) {
    const page = normalizePagination(pagination);
    const [artists, albums, items] = await Promise.all([
        prisma.artist.count({ where: artistWhere }),
        prisma.album.count({ where }),
        prisma.album.findMany({
            where,
            select: ALBUM_SELECT,
            orderBy: [{ title: "asc" }, { id: "asc" }],
            take: page.limit,
            skip: page.offset,
        }),
    ]);
    return {
        kind,
        counts: { artists, albums },
        items,
        total: albums,
        ...page,
    };
}

async function listTrackGap(
    kind: "missing-genres" | "missing-lyrics",
    where: Prisma.TrackWhereInput,
    pagination: LibraryHealthPagination,
) {
    const page = normalizePagination(pagination);
    const [total, rows] = await Promise.all([
        prisma.track.count({ where }),
        prisma.track.findMany({
            where,
            select: TRACK_SELECT,
            orderBy: [{ title: "asc" }, { id: "asc" }],
            take: page.limit,
            skip: page.offset,
        }),
    ]);
    const items = rows.map((row) => ({
        id: row.id,
        title: row.title,
        filePath: row.filePath,
        albumTitle: row.album.title,
        artistName: row.album.artist.name,
    }));
    return { kind, counts: { tracks: total }, items, total, ...page };
}

/** Returns one bounded metadata-gap drill-down page. */
export function listMetadataGap(
    kind: MetadataGapKind,
    pagination: LibraryHealthPagination,
) {
    if (kind === "missing-art") {
        return listAlbumGap(
            kind,
            MISSING_ART_ALBUM_WHERE,
            MISSING_ART_ARTIST_WHERE,
            pagination,
        );
    }
    if (kind === "missing-mbid") {
        return listAlbumGap(
            kind,
            MISSING_MBID_ALBUM_WHERE,
            MISSING_MBID_ARTIST_WHERE,
            pagination,
        );
    }
    return listTrackGap(
        kind,
        kind === "missing-genres" ? MISSING_GENRES_WHERE : MISSING_LYRICS_WHERE,
        pagination,
    );
}
