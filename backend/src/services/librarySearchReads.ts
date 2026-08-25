import { type AlbumLocation, Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import {
    buildLibraryAlbumWhere,
    buildLibraryTrackWhere,
} from "./libraryArtistReads";

interface PageSlice {
    limit: number;
    offset: number;
}

/** Independent entity slices and visibility scope for a library music search. */
export interface LibraryMusicSearchOptions {
    query: string;
    albumLocations: readonly AlbumLocation[];
    artists: PageSlice;
    albums: PageSlice;
    tracks: PageSlice;
}

const trackSelect = Prisma.validator<Prisma.TrackSelect>()({
    id: true,
    title: true,
    trackNo: true,
    discNo: true,
    duration: true,
    fileSize: true,
    mime: true,
    filePath: true,
    loudnessLufs: true,
    truePeakDb: true,
    album: {
        select: {
            id: true,
            title: true,
            year: true,
            coverUrl: true,
            location: true,
            genres: true,
            userGenres: true,
            albumLoudnessLufs: true,
            albumTruePeakDb: true,
            artist: { select: { id: true, name: true } },
        },
    },
});

/** Track fields required by transport-specific library serializers. */
export type LibrarySearchTrack = Prisma.TrackGetPayload<{
    select: typeof trackSelect;
}>;

/** Neutral artist search projection. */
export interface LibrarySearchArtist {
    id: string;
    name: string;
    heroUrl: string | null;
    albumCount: number;
}

/** Neutral album search projection with visible-track aggregates. */
export interface LibrarySearchAlbum {
    id: string;
    title: string;
    year: number | null;
    lastSynced: Date;
    coverUrl: string | null;
    location: AlbumLocation;
    genres: Prisma.JsonValue;
    userGenres: Prisma.JsonValue;
    artist: { id: string; name: string };
    songCount: number;
    duration: number;
    trackIds: string[];
}

/** Neutral artist, album, and track search result. */
export interface LibraryMusicSearchResult {
    artists: LibrarySearchArtist[];
    albums: LibrarySearchAlbum[];
    tracks: LibrarySearchTrack[];
}

function contains(value: string) {
    return { contains: value, mode: Prisma.QueryMode.insensitive };
}

function searchArtists(
    options: LibraryMusicSearchOptions,
    albumWhere: Prisma.AlbumWhereInput,
) {
    return prisma.artist.findMany({
        where: {
            albums: { some: albumWhere },
            ...(options.query ? { name: contains(options.query) } : {}),
        },
        select: {
            id: true,
            name: true,
            heroUrl: true,
            _count: { select: { albums: { where: albumWhere } } },
        },
        orderBy: { name: Prisma.SortOrder.asc },
        take: options.artists.limit,
        skip: options.artists.offset,
    });
}

function searchAlbums(
    options: LibraryMusicSearchOptions,
    albumWhere: Prisma.AlbumWhereInput,
    trackWhere: Prisma.TrackWhereInput,
) {
    const queryWhere = options.query
        ? {
              OR: [
                  { title: contains(options.query) },
                  { artist: { name: contains(options.query) } },
              ],
          }
        : {};
    return prisma.album.findMany({
        where: { ...albumWhere, ...queryWhere },
        select: {
            id: true,
            title: true,
            year: true,
            lastSynced: true,
            coverUrl: true,
            location: true,
            genres: true,
            userGenres: true,
            artist: { select: { id: true, name: true } },
            tracks: {
                where: trackWhere,
                select: { id: true, duration: true },
            },
            _count: { select: { tracks: { where: trackWhere } } },
        },
        orderBy: { title: Prisma.SortOrder.asc },
        take: options.albums.limit,
        skip: options.albums.offset,
    });
}

function searchTracks(
    options: LibraryMusicSearchOptions,
    trackWhere: Prisma.TrackWhereInput,
) {
    const queryWhere = options.query
        ? {
              OR: [
                  { title: contains(options.query) },
                  { album: { title: contains(options.query) } },
                  {
                      album: {
                          artist: { name: contains(options.query) },
                      },
                  },
              ],
          }
        : {};
    return prisma.track.findMany({
        where: { ...trackWhere, ...queryWhere },
        select: trackSelect,
        orderBy: [
            { title: Prisma.SortOrder.asc },
            { id: Prisma.SortOrder.asc },
        ],
        take: options.tracks.limit,
        skip: options.tracks.offset,
    });
}

type AlbumRow = Awaited<ReturnType<typeof searchAlbums>>[number];

function mapAlbum(album: AlbumRow): LibrarySearchAlbum {
    return {
        id: album.id,
        title: album.title,
        year: album.year,
        lastSynced: album.lastSynced,
        coverUrl: album.coverUrl,
        location: album.location,
        genres: album.genres,
        userGenres: album.userGenres,
        artist: album.artist,
        songCount: album._count.tracks,
        duration: album.tracks.reduce(
            (sum, track) => sum + (track.duration ?? 0),
            0,
        ),
        trackIds: album.tracks.map((track) => track.id),
    };
}

/**
 * Searches the local library read model with independent entity paging.
 * Empty queries intentionally list the selected library scope.
 */
export async function searchLibraryMusic(
    options: LibraryMusicSearchOptions,
): Promise<LibraryMusicSearchResult> {
    const albumWhere = buildLibraryAlbumWhere(options.albumLocations);
    const trackWhere = buildLibraryTrackWhere(options.albumLocations);
    const [artists, albums, tracks] = await Promise.all([
        searchArtists(options, albumWhere),
        searchAlbums(options, albumWhere, trackWhere),
        searchTracks(options, trackWhere),
    ]);

    return {
        artists: artists.map((artist) => ({
            id: artist.id,
            name: artist.name,
            heroUrl: artist.heroUrl,
            albumCount: artist._count.albums,
        })),
        albums: albums.map(mapAlbum),
        tracks,
    };
}
