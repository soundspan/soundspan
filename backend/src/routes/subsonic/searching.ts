import { type Request, type Response } from "express";
import { prisma } from "../../utils/db";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    formatAlbumForSubsonic,
    formatArtistForSubsonic,
    formatSongForSubsonic,
    getRequestContext,
    getRequiredQueryValue,
    isUnsupportedMusicFolderId,
    LIBRARY_ALBUM_WHERE,
    LIBRARY_TRACK_WHERE,
    combineSongEnrichmentForAlbum,
    loadSongEnrichmentByTrackId,
    normalizeSearchQuery,
    parseOffsetParam,
    parseSearchCountParam,
    SEARCH_ALBUM_MAX_COUNT,
    SEARCH_ARTIST_MAX_COUNT,
    SEARCH_SONG_MAX_COUNT,
    SONG_LOUDNESS_ALBUM_SELECT,
    SONG_LOUDNESS_TRACK_SELECT,
    SUBSONIC_ALBUM_LOCATION_WHERE,
} from "./shared";

/**
 * Executes handleSearch3.
 */
export async function handleSearch3(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawQuery = getRequiredQueryValue(req, res, "query", format, callback);
    if (rawQuery === null) {
        return;
    }

    if (isUnsupportedMusicFolderId(req.query.musicFolderId)) {
        sendSubsonicSuccess(
            res,
            {
                searchResult3: {
                    artist: [],
                    album: [],
                    song: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    const query = normalizeSearchQuery(rawQuery);

    const artistCount = parseSearchCountParam(
        req.query.artistCount,
        20,
        SEARCH_ARTIST_MAX_COUNT,
    );
    const albumCount = parseSearchCountParam(
        req.query.albumCount,
        20,
        SEARCH_ALBUM_MAX_COUNT,
    );
    const songCount = parseSearchCountParam(
        req.query.songCount,
        20,
        SEARCH_SONG_MAX_COUNT,
    );

    const artistOffset = parseOffsetParam(req.query.artistOffset);
    const albumOffset = parseOffsetParam(req.query.albumOffset);
    const songOffset = parseOffsetParam(req.query.songOffset);

    try {
        const [artists, albums, tracks] = await Promise.all([
            prisma.artist.findMany({
                where: {
                    albums: {
                        some: LIBRARY_ALBUM_WHERE,
                    },
                    ...(query
                        ? {
                              name: {
                                  contains: query,
                                  mode: "insensitive" as const,
                              },
                          }
                        : {}),
                },
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: { where: LIBRARY_ALBUM_WHERE },
                        },
                    },
                },
                orderBy: {
                    name: "asc",
                },
                take: artistCount,
                skip: artistOffset,
            }),
            prisma.album.findMany({
                where: {
                    ...LIBRARY_ALBUM_WHERE,
                    ...(query
                        ? {
                              OR: [
                                  {
                                      title: {
                                          contains: query,
                                          mode: "insensitive" as const,
                                      },
                                  },
                                  {
                                      artist: {
                                          name: {
                                              contains: query,
                                              mode: "insensitive" as const,
                                          },
                                      },
                                  },
                              ],
                          }
                        : {}),
                },
                select: {
                    id: true,
                    title: true,
                    year: true,
                    lastSynced: true,
                    coverUrl: true,
                    location: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                    tracks: {
                        where: LIBRARY_TRACK_WHERE,
                        select: {
                            id: true,
                            duration: true,
                        },
                    },
                    _count: {
                        select: {
                            tracks: {
                                where: LIBRARY_TRACK_WHERE,
                            },
                        },
                    },
                },
                orderBy: {
                    title: "asc",
                },
                take: albumCount,
                skip: albumOffset,
            }),
            prisma.track.findMany({
                where: {
                    ...LIBRARY_TRACK_WHERE,
                    album: {
                        location: SUBSONIC_ALBUM_LOCATION_WHERE,
                    },
                    ...(query
                        ? {
                              OR: [
                                  {
                                      title: {
                                          contains: query,
                                          mode: "insensitive" as const,
                                      },
                                  },
                                  {
                                      album: {
                                          title: {
                                              contains: query,
                                              mode: "insensitive" as const,
                                          },
                                      },
                                  },
                                  {
                                      album: {
                                          artist: {
                                              name: {
                                                  contains: query,
                                                  mode: "insensitive" as const,
                                              },
                                          },
                                      },
                                  },
                              ],
                          }
                        : {}),
                },
                select: {
                    id: true,
                    title: true,
                    trackNo: true,
                    discNo: true,
                    duration: true,
                    fileSize: true,
                    mime: true,
                    filePath: true,
                    ...SONG_LOUDNESS_TRACK_SELECT,
                    album: {
                        select: {
                            id: true,
                            title: true,
                            year: true,
                            coverUrl: true,
                            location: true,
                            genres: true,
                            userGenres: true,
                            ...SONG_LOUDNESS_ALBUM_SELECT,
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
                orderBy: [{ title: "asc" }, { id: "asc" }],
                take: songCount,
                skip: songOffset,
            }),
        ]);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            [
                ...tracks.map((track) => track.id),
                ...albums.flatMap((album) =>
                    album.tracks.map((track) => track.id),
                ),
            ],
        );

        sendSubsonicSuccess(
            res,
            {
                searchResult3: {
                    artist: artists.map((artist) =>
                        formatArtistForSubsonic({
                            id: artist.id,
                            name: artist.name,
                            albumCount: artist._count.albums,
                            heroUrl: artist.heroUrl,
                        }),
                    ),
                    album: albums.map((album) =>
                        formatAlbumForSubsonic(
                            {
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
                            },
                            combineSongEnrichmentForAlbum(
                                album.tracks.map((track) => track.id),
                                playedAtByTrackId,
                            ),
                        ),
                    ),
                    song: tracks.map((track) =>
                        formatSongForSubsonic(
                            track,
                            playedAtByTrackId.get(track.id),
                        ),
                    ),
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to search",
            format,
            callback,
        );
    }
}
async function handleSearchLike(
    req: Request,
    res: Response,
    responseKey: "searchResult" | "searchResult2",
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawQuery = getRequiredQueryValue(req, res, "query", format, callback);
    if (rawQuery === null) {
        return;
    }

    if (isUnsupportedMusicFolderId(req.query.musicFolderId)) {
        const payload: Record<string, unknown> = {};
        payload[responseKey] = {
            artist: [],
            album: [],
            song: [],
        };

        sendSubsonicSuccess(res, payload, format, callback);
        return;
    }

    const query = normalizeSearchQuery(rawQuery);

    const artistCount = parseSearchCountParam(
        req.query.artistCount,
        20,
        SEARCH_ARTIST_MAX_COUNT,
    );
    const albumCount = parseSearchCountParam(
        req.query.albumCount,
        20,
        SEARCH_ALBUM_MAX_COUNT,
    );
    const songCount = parseSearchCountParam(
        req.query.songCount,
        20,
        SEARCH_SONG_MAX_COUNT,
    );

    const artistOffset = parseOffsetParam(req.query.artistOffset);
    const albumOffset = parseOffsetParam(req.query.albumOffset);
    const songOffset = parseOffsetParam(req.query.songOffset);

    try {
        const [artists, albums, tracks] = await Promise.all([
            prisma.artist.findMany({
                where: {
                    albums: {
                        some: LIBRARY_ALBUM_WHERE,
                    },
                    ...(query
                        ? {
                              name: {
                                  contains: query,
                                  mode: "insensitive" as const,
                              },
                          }
                        : {}),
                },
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: { where: LIBRARY_ALBUM_WHERE },
                        },
                    },
                },
                orderBy: {
                    name: "asc",
                },
                take: artistCount,
                skip: artistOffset,
            }),
            prisma.album.findMany({
                where: {
                    ...LIBRARY_ALBUM_WHERE,
                    ...(query
                        ? {
                              OR: [
                                  {
                                      title: {
                                          contains: query,
                                          mode: "insensitive" as const,
                                      },
                                  },
                                  {
                                      artist: {
                                          name: {
                                              contains: query,
                                              mode: "insensitive" as const,
                                          },
                                      },
                                  },
                              ],
                          }
                        : {}),
                },
                select: {
                    id: true,
                    title: true,
                    year: true,
                    lastSynced: true,
                    coverUrl: true,
                    location: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                    tracks: {
                        where: LIBRARY_TRACK_WHERE,
                        select: {
                            id: true,
                            duration: true,
                        },
                    },
                    _count: {
                        select: {
                            tracks: {
                                where: LIBRARY_TRACK_WHERE,
                            },
                        },
                    },
                },
                orderBy: {
                    title: "asc",
                },
                take: albumCount,
                skip: albumOffset,
            }),
            prisma.track.findMany({
                where: {
                    ...LIBRARY_TRACK_WHERE,
                    album: {
                        location: SUBSONIC_ALBUM_LOCATION_WHERE,
                    },
                    ...(query
                        ? {
                              OR: [
                                  {
                                      title: {
                                          contains: query,
                                          mode: "insensitive" as const,
                                      },
                                  },
                                  {
                                      album: {
                                          title: {
                                              contains: query,
                                              mode: "insensitive" as const,
                                          },
                                      },
                                  },
                                  {
                                      album: {
                                          artist: {
                                              name: {
                                                  contains: query,
                                                  mode: "insensitive" as const,
                                              },
                                          },
                                      },
                                  },
                              ],
                          }
                        : {}),
                },
                select: {
                    id: true,
                    title: true,
                    trackNo: true,
                    discNo: true,
                    duration: true,
                    fileSize: true,
                    mime: true,
                    filePath: true,
                    ...SONG_LOUDNESS_TRACK_SELECT,
                    album: {
                        select: {
                            id: true,
                            title: true,
                            year: true,
                            coverUrl: true,
                            location: true,
                            genres: true,
                            userGenres: true,
                            ...SONG_LOUDNESS_ALBUM_SELECT,
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
                orderBy: [{ title: "asc" }, { id: "asc" }],
                take: songCount,
                skip: songOffset,
            }),
        ]);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            [
                ...tracks.map((track) => track.id),
                ...albums.flatMap((album) =>
                    album.tracks.map((track) => track.id),
                ),
            ],
        );

        const searchResultPayload = {
            artist: artists.map((artist) =>
                formatArtistForSubsonic({
                    id: artist.id,
                    name: artist.name,
                    albumCount: artist._count.albums,
                    heroUrl: artist.heroUrl,
                }),
            ),
            album: albums.map((album) =>
                formatAlbumForSubsonic(
                    {
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
                    },
                    combineSongEnrichmentForAlbum(
                        album.tracks.map((track) => track.id),
                        playedAtByTrackId,
                    ),
                ),
            ),
            song: tracks.map((track) =>
                formatSongForSubsonic(track, playedAtByTrackId.get(track.id)),
            ),
        };

        const payload: Record<string, unknown> = {};
        payload[responseKey] = searchResultPayload;

        sendSubsonicSuccess(res, payload, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to search",
            format,
            callback,
        );
    }
}

/**
 * Executes handleSearch.
 */
export async function handleSearch(req: Request, res: Response): Promise<void> {
    await handleSearchLike(req, res, "searchResult");
}

/**
 * Executes handleSearch2.
 */
export async function handleSearch2(
    req: Request,
    res: Response,
): Promise<void> {
    await handleSearchLike(req, res, "searchResult2");
}
