import { type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import {
    allocateTracksWithArtistWeighting,
    seededShuffle,
} from "../../services/artistSlotAllocation";
import { prisma } from "../../utils/db";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    albumListSelect,
    buildAlbumPlayStats,
    formatAlbumForSubsonic,
    formatArtistForSubsonic,
    formatSongForSubsonic,
    getRequestContext,
    LIBRARY_ALBUM_WHERE,
    LIBRARY_TRACK_WHERE,
    combineSongEnrichmentForAlbum,
    loadSongEnrichmentByTrackId,
    mapAlbumsForSubsonic,
    parseAlbumListType,
    parseCountParam,
    parseOffsetParam,
    parseYearParam,
    shuffleInPlace,
    SONG_LOUDNESS_ALBUM_SELECT,
    SONG_LOUDNESS_TRACK_SELECT,
    SUBSONIC_ALBUM_LOCATION_WHERE,
    SUBSONIC_MUSIC_FOLDER_ID,
    type AlbumListRecord,
    type SongEnrichment,
} from "./shared";

async function handleGetAlbumListLike(
    req: Request,
    res: Response,
    responseKey: "albumList" | "albumList2",
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawType = req.query.type;
    const type = parseAlbumListType(rawType);

    if (!type) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'type' is missing or invalid",
            format,
            callback,
        );
        return;
    }

    const size = parseCountParam(req.query.size, 10, 500);
    const offset = parseOffsetParam(req.query.offset);
    const musicFolderId =
        typeof req.query.musicFolderId === "string"
            ? req.query.musicFolderId
            : "";

    if (musicFolderId && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID) {
        const payload: Record<string, unknown> = {};
        payload[responseKey] = {
            album: [],
        };

        sendSubsonicSuccess(res, payload, format, callback);
        return;
    }

    try {
        let albums: AlbumListRecord[] = [];
        let enrichmentByAlbumId = new Map<string, SongEnrichment>();
        let playEnrichmentByTrackId:
            | ReadonlyMap<string, SongEnrichment>
            | undefined;

        if (type === "starred") {
            albums = [];
        } else if (type === "random") {
            const candidates = await prisma.album.findMany({
                where: LIBRARY_ALBUM_WHERE,
                select: albumListSelect,
                orderBy: {
                    id: "asc",
                },
                take: 500,
            });
            shuffleInPlace(candidates);
            albums = candidates.slice(offset, offset + size);
        } else if (
            type === "frequent" ||
            type === "highest" ||
            type === "recent"
        ) {
            const playStats = await buildAlbumPlayStats(req.user!.id);
            const albumStats = playStats.byAlbumId;
            playEnrichmentByTrackId = playStats.byTrackId;
            enrichmentByAlbumId = new Map(
                Array.from(albumStats, ([albumId, stats]) => [
                    albumId,
                    {
                        playedAt: stats.lastPlayed ?? undefined,
                        playCount: stats.playCount || undefined,
                    },
                ]),
            );
            const sortedAlbumIds = Array.from(albumStats.entries())
                .sort(([leftId, left], [rightId, right]) => {
                    if (type === "recent") {
                        const leftTimestamp = left.lastPlayed?.getTime() ?? 0;
                        const rightTimestamp = right.lastPlayed?.getTime() ?? 0;
                        if (leftTimestamp !== rightTimestamp) {
                            return rightTimestamp - leftTimestamp;
                        }
                        if (left.playCount !== right.playCount) {
                            return right.playCount - left.playCount;
                        }
                        return leftId.localeCompare(rightId);
                    }

                    if (left.playCount !== right.playCount) {
                        return right.playCount - left.playCount;
                    }

                    const leftTimestamp = left.lastPlayed?.getTime() ?? 0;
                    const rightTimestamp = right.lastPlayed?.getTime() ?? 0;
                    if (leftTimestamp !== rightTimestamp) {
                        return rightTimestamp - leftTimestamp;
                    }

                    return leftId.localeCompare(rightId);
                })
                .map(([albumId]) => albumId);

            const pagedAlbumIds = sortedAlbumIds.slice(offset, offset + size);

            if (pagedAlbumIds.length > 0) {
                const fetchedAlbums = await prisma.album.findMany({
                    where: {
                        id: {
                            in: pagedAlbumIds,
                        },
                        ...LIBRARY_ALBUM_WHERE,
                    },
                    select: albumListSelect,
                });

                const albumById = new Map(
                    fetchedAlbums.map((album) => [album.id, album]),
                );
                albums = pagedAlbumIds
                    .map((albumId) => albumById.get(albumId))
                    .filter((album): album is AlbumListRecord =>
                        Boolean(album),
                    );
            }
        } else {
            const where: Prisma.AlbumWhereInput = {
                ...LIBRARY_ALBUM_WHERE,
            };
            let orderBy: Prisma.AlbumOrderByWithRelationInput[] = [
                { title: "asc" },
                { id: "asc" },
            ];

            if (type === "newest") {
                orderBy = [
                    { lastSynced: "desc" },
                    { title: "asc" },
                    { id: "asc" },
                ];
            } else if (type === "alphabeticalByArtist") {
                orderBy = [
                    { artist: { name: "asc" } },
                    { title: "asc" },
                    { id: "asc" },
                ];
            } else if (type === "byYear") {
                const fromYear = parseYearParam(req.query.fromYear);
                const toYear = parseYearParam(req.query.toYear);
                if (fromYear === null || toYear === null) {
                    sendSubsonicError(
                        res,
                        SubsonicErrorCode.MISSING_PARAMETER,
                        "Required parameters 'fromYear' and 'toYear' are missing or invalid",
                        format,
                        callback,
                    );
                    return;
                }

                where.year = {
                    gte: Math.min(fromYear, toYear),
                    lte: Math.max(fromYear, toYear),
                };
                orderBy = [
                    { year: fromYear > toYear ? "desc" : "asc" },
                    { title: "asc" },
                    { id: "asc" },
                ];
            } else if (type === "byGenre") {
                const genre =
                    typeof req.query.genre === "string"
                        ? req.query.genre.trim()
                        : "";
                if (!genre) {
                    sendSubsonicError(
                        res,
                        SubsonicErrorCode.MISSING_PARAMETER,
                        "Required parameter 'genre' is missing",
                        format,
                        callback,
                    );
                    return;
                }

                where.tracks = {
                    some: {
                        ...LIBRARY_TRACK_WHERE,
                        trackGenres: {
                            some: {
                                genre: {
                                    name: {
                                        equals: genre,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                    },
                };
            }

            albums = await prisma.album.findMany({
                where,
                select: albumListSelect,
                orderBy,
                skip: offset,
                take: size,
            });
        }

        const payload: Record<string, unknown> = {};
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            albums.flatMap((album) => album.tracks.map((track) => track.id)),
            undefined,
            playEnrichmentByTrackId,
        );
        for (const album of albums) {
            const aggregate = combineSongEnrichmentForAlbum(
                album.tracks.map((track) => track.id),
                playedAtByTrackId,
            );
            enrichmentByAlbumId.set(album.id, {
                ...aggregate,
                ...enrichmentByAlbumId.get(album.id),
                starredAt: aggregate.starredAt,
            });
        }
        payload[responseKey] = {
            album: mapAlbumsForSubsonic(
                albums,
                playedAtByTrackId,
                enrichmentByAlbumId,
            ),
        };

        sendSubsonicSuccess(res, payload, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch album list",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetAlbumList.
 */
export async function handleGetAlbumList(
    req: Request,
    res: Response,
): Promise<void> {
    await handleGetAlbumListLike(req, res, "albumList");
}

/**
 * Executes handleGetAlbumList2.
 */
export async function handleGetAlbumList2(
    req: Request,
    res: Response,
): Promise<void> {
    await handleGetAlbumListLike(req, res, "albumList2");
}
/**
 * Executes handleGetSongsByGenre.
 */
export async function handleGetSongsByGenre(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const genre =
        typeof req.query.genre === "string" ? req.query.genre.trim() : "";

    if (!genre) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'genre' is missing",
            format,
            callback,
        );
        return;
    }

    const count = parseCountParam(req.query.count, 50, 500);
    const offset = parseOffsetParam(req.query.offset);
    const musicFolderId =
        typeof req.query.musicFolderId === "string"
            ? req.query.musicFolderId
            : "";

    if (musicFolderId && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID) {
        sendSubsonicSuccess(
            res,
            {
                songsByGenre: {
                    song: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    try {
        // Every request used to return the same deterministic alphabetical
        // slice (GH #46). Matching ids are now ordered by a DAY-STABLE
        // seeded shuffle: offset pagination stays coherent within a day
        // while composition varies across days.
        const matchingTracks = await prisma.track.findMany({
            where: {
                ...LIBRARY_TRACK_WHERE,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
                },
                trackGenres: {
                    some: {
                        genre: {
                            name: {
                                equals: genre,
                                mode: "insensitive",
                            },
                        },
                    },
                },
            },
            select: { id: true },
            // Deterministic base order: the seeded shuffle is only
            // day-stable (and offset pagination only coherent) when its
            // input order is stable across requests and query plans.
            orderBy: { id: "asc" },
        });
        const dayKey = new Date().toISOString().slice(0, 10);
        const orderedIds = seededShuffle(
            matchingTracks.map((t) => t.id),
            `subsonic-songs-by-genre-${genre.toLowerCase()}-${dayKey}`,
        );
        const pageIds = orderedIds.slice(offset, offset + count);
        const trackRows =
            pageIds.length > 0
                ? await prisma.track.findMany({
                      where: {
                          ...LIBRARY_TRACK_WHERE,
                          id: { in: pageIds },
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
                  })
                : [];
        const trackRowById = new Map(trackRows.map((row) => [row.id, row]));
        const tracks = pageIds
            .map((id) => trackRowById.get(id))
            .filter((row): row is NonNullable<typeof row> => row !== undefined);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            tracks.map((track) => track.id),
        );

        sendSubsonicSuccess(
            res,
            {
                songsByGenre: {
                    song: tracks.map((track) =>
                        formatSongForSubsonic(
                            {
                                ...track,
                                genre,
                            },
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
            "Failed to fetch songs by genre",
            format,
            callback,
        );
    }
}

/**
 * Return a flat shuffled Subsonic song sample with weighted artist diversity.
 */
export async function handleGetRandomSongs(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const size = parseCountParam(req.query.size, 10, 500);
    const musicFolderId =
        typeof req.query.musicFolderId === "string"
            ? req.query.musicFolderId
            : "";
    const genre =
        typeof req.query.genre === "string" ? req.query.genre.trim() : "";
    const fromYear = parseYearParam(req.query.fromYear);
    const toYear = parseYearParam(req.query.toYear);

    if (musicFolderId && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID) {
        sendSubsonicSuccess(
            res,
            {
                randomSongs: {
                    song: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    try {
        const where: Prisma.TrackWhereInput = {
            ...LIBRARY_TRACK_WHERE,
            album: {
                location: SUBSONIC_ALBUM_LOCATION_WHERE,
            },
        };

        if (genre) {
            where.trackGenres = {
                some: {
                    genre: {
                        name: {
                            equals: genre,
                            mode: "insensitive",
                        },
                    },
                },
            };
        }

        if (fromYear !== null || toYear !== null) {
            const minYear = fromYear ?? toYear;
            const maxYear = toYear ?? fromYear;
            where.album = {
                location: SUBSONIC_ALBUM_LOCATION_WHERE,
                year: {
                    ...(minYear !== null ? { gte: minYear } : {}),
                    ...(maxYear !== null ? { lte: maxYear } : {}),
                },
            };
        }

        const candidates = await prisma.track.findMany({
            where,
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
            orderBy: {
                id: "asc",
            },
            take: 5000,
        });

        const selectedCandidates = allocateTracksWithArtistWeighting(
            candidates,
            (track) => track.album.artist.id,
            { targetCount: size },
        );
        if (selectedCandidates.length < size) {
            const selectedTrackIds = new Set(
                selectedCandidates.map((track) => track.id),
            );
            const remainingCandidates = candidates.filter(
                (track) => !selectedTrackIds.has(track.id),
            );
            shuffleInPlace(remainingCandidates);
            selectedCandidates.push(
                ...remainingCandidates.slice(
                    0,
                    size - selectedCandidates.length,
                ),
            );
        }
        shuffleInPlace(selectedCandidates);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            selectedCandidates.map((track) => track.id),
        );
        const songs = selectedCandidates.map((track) =>
            formatSongForSubsonic(
                {
                    ...track,
                    genre: genre || undefined,
                },
                playedAtByTrackId.get(track.id),
            ),
        );

        sendSubsonicSuccess(
            res,
            {
                randomSongs: {
                    song: songs,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch random songs",
            format,
            callback,
        );
    }
}
type StarredSongEntry = Record<string, unknown>;
type StarredAlbumEntry = Record<string, unknown>;
type StarredArtistEntry = Record<string, unknown>;

async function buildStarredPayload(userId: string): Promise<{
    artist: StarredArtistEntry[];
    album: StarredAlbumEntry[];
    song: StarredSongEntry[];
}> {
    const likedTracks = await prisma.likedTrack.findMany({
        where: {
            userId,
            track: {
                ...LIBRARY_TRACK_WHERE,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
                },
            },
        },
        orderBy: {
            likedAt: "desc",
        },
        include: {
            track: {
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
            },
        },
    });

    const albumStarredAt = new Map<string, Date>();
    const artistStarredAt = new Map<string, Date>();

    for (const likedTrack of likedTracks) {
        const albumId = likedTrack.track.album.id;
        const artistId = likedTrack.track.album.artist.id;
        const likedAt = likedTrack.likedAt;

        const currentAlbumDate = albumStarredAt.get(albumId);
        if (!currentAlbumDate || likedAt > currentAlbumDate) {
            albumStarredAt.set(albumId, likedAt);
        }

        const currentArtistDate = artistStarredAt.get(artistId);
        if (!currentArtistDate || likedAt > currentArtistDate) {
            artistStarredAt.set(artistId, likedAt);
        }
    }

    const albumIds = Array.from(albumStarredAt.keys());
    const [albums, artists, albumTrackStats, albumTracks] = await Promise.all([
        albumStarredAt.size > 0
            ? prisma.album.findMany({
                  where: {
                      id: {
                          in: albumIds,
                      },
                      ...LIBRARY_ALBUM_WHERE,
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
                  },
              })
            : Promise.resolve([]),
        artistStarredAt.size > 0
            ? prisma.artist.findMany({
                  where: {
                      id: {
                          in: Array.from(artistStarredAt.keys()),
                      },
                      albums: {
                          some: LIBRARY_ALBUM_WHERE,
                      },
                  },
                  select: {
                      id: true,
                      name: true,
                      heroUrl: true,
                      _count: {
                          select: {
                              albums: {
                                  where: LIBRARY_ALBUM_WHERE,
                              },
                          },
                      },
                  },
              })
            : Promise.resolve([]),
        albumIds.length > 0
            ? prisma.track.groupBy({
                  by: ["albumId"],
                  where: {
                      ...LIBRARY_TRACK_WHERE,
                      albumId: { in: albumIds },
                  },
                  _count: { _all: true },
                  _sum: { duration: true },
              })
            : Promise.resolve([]),
        albumIds.length > 0
            ? prisma.track.findMany({
                  where: {
                      ...LIBRARY_TRACK_WHERE,
                      albumId: { in: albumIds },
                  },
                  select: { id: true, albumId: true },
              })
            : Promise.resolve([]),
    ]);
    const albumTrackStatsById = new Map(
        albumTrackStats.map((row) => [row.albumId, row]),
    );
    const trackIdsByAlbumId = new Map<string, string[]>();
    for (const track of albumTracks) {
        const trackIds = trackIdsByAlbumId.get(track.albumId) ?? [];
        trackIds.push(track.id);
        trackIdsByAlbumId.set(track.albumId, trackIds);
    }
    const playedAtByTrackId = await loadSongEnrichmentByTrackId(
        userId,
        [
            ...likedTracks.map((likedTrack) => likedTrack.track.id),
            ...albumTracks.map((track) => track.id),
        ],
        new Map(
            likedTracks.map((likedTrack) => [
                likedTrack.track.id,
                likedTrack.likedAt,
            ]),
        ),
    );
    const songs = likedTracks.map((likedTrack) => ({
        ...formatSongForSubsonic(
            likedTrack.track,
            playedAtByTrackId.get(likedTrack.track.id),
        ),
        starred: likedTrack.likedAt.toISOString(),
    }));

    const albumEntries = albums
        .map((album) => {
            const stats = albumTrackStatsById.get(album.id);
            return {
                ...formatAlbumForSubsonic(
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
                        songCount: stats?._count._all ?? 0,
                        duration: stats?._sum.duration ?? 0,
                    },
                    combineSongEnrichmentForAlbum(
                        trackIdsByAlbumId.get(album.id) ?? [],
                        playedAtByTrackId,
                    ),
                ),
                starred: albumStarredAt.get(album.id)?.toISOString(),
            };
        })
        .sort((left, right) =>
            String(right.starred ?? "").localeCompare(
                String(left.starred ?? ""),
            ),
        );

    const artistEntries = artists
        .map((artist) => ({
            ...formatArtistForSubsonic({
                id: artist.id,
                name: artist.name,
                albumCount: artist._count.albums,
                heroUrl: artist.heroUrl,
            }),
            starred: artistStarredAt.get(artist.id)?.toISOString(),
        }))
        .sort((left, right) =>
            String(right.starred ?? "").localeCompare(
                String(left.starred ?? ""),
            ),
        );

    return {
        artist: artistEntries,
        album: albumEntries,
        song: songs,
    };
}

/**
 * Executes handleGetStarred2.
 */
export async function handleGetStarred2(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const starred = await buildStarredPayload(req.user!.id);

        sendSubsonicSuccess(
            res,
            {
                starred2: starred,
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch starred tracks",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetStarred.
 */
export async function handleGetStarred(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const starred = await buildStarredPayload(req.user!.id);
        sendSubsonicSuccess(
            res,
            {
                starred,
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch starred tracks",
            format,
            callback,
        );
    }
}
