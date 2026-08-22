import { type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { parseSubsonicId } from "../../utils/subsonicIds";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    extractGenreValues,
    formatSongForSubsonic,
    getRequestContext,
    getRequiredQueryString,
    LIBRARY_ALBUM_WHERE,
    LIBRARY_TRACK_WHERE,
    loadSongEnrichmentByTrackId,
    parseCountParam,
    parseEntityIdOrNotFound,
    SONG_LOUDNESS_ALBUM_SELECT,
    SONG_LOUDNESS_TRACK_SELECT,
    SUBSONIC_ALBUM_LOCATION_WHERE,
    SUBSONIC_MUSIC_FOLDER_ID,
} from "./shared";

async function findSimilarArtistIds(artistId: string): Promise<string[]> {
    const artist = await prisma.artist.findFirst({
        where: {
            id: artistId,
            albums: {
                some: LIBRARY_ALBUM_WHERE,
            },
        },
        select: {
            similarFrom: {
                select: {
                    toArtist: {
                        select: {
                            id: true,
                            albums: {
                                where: LIBRARY_ALBUM_WHERE,
                                select: {
                                    id: true,
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    weight: "desc",
                },
                take: 50,
            },
        },
    });

    if (!artist) {
        return [];
    }

    return artist.similarFrom
        .map((entry) => entry.toArtist)
        .filter((candidate) => candidate.albums.length > 0)
        .map((candidate) => candidate.id);
}

function collectTrackGenreValues(track: {
    album: {
        genres?: unknown;
        userGenres?: unknown;
    };
    trackGenres: Array<{
        genre: {
            name: string;
        };
    }>;
}): string[] {
    const explicitTrackGenres = track.trackGenres
        .map((entry) => entry.genre.name.trim())
        .filter((value) => value.length > 0);

    return Array.from(
        new Set([
            ...explicitTrackGenres,
            ...extractGenreValues(track.album.userGenres),
            ...extractGenreValues(track.album.genres),
        ]),
    );
}

function buildGenreTrackFilter(
    genreValues: string[],
): Prisma.TrackWhereInput | null {
    if (genreValues.length === 0) {
        return null;
    }

    return {
        trackGenres: {
            some: {
                OR: genreValues.map((genre) => ({
                    genre: {
                        name: {
                            equals: genre,
                            mode: "insensitive",
                        },
                    },
                })),
            },
        },
    };
}

const similarSongTrackSelect = Prisma.validator<Prisma.TrackSelect>()({
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
});

type SimilarSongTrackRecord = Prisma.TrackGetPayload<{
    select: typeof similarSongTrackSelect;
}>;
function mergeUniqueTracks(
    trackGroups: SimilarSongTrackRecord[][],
): SimilarSongTrackRecord[] {
    const merged: SimilarSongTrackRecord[] = [];
    const seenTrackIds = new Set<string>();

    for (const group of trackGroups) {
        for (const track of group) {
            if (seenTrackIds.has(track.id)) {
                continue;
            }
            seenTrackIds.add(track.id);
            merged.push(track);
        }
    }

    return merged;
}

/**
 * Executes handleGetSimilarSongs.
 */
export async function handleGetSimilarSongs(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const artistId = parseEntityIdOrNotFound(
        req,
        res,
        rawId,
        "artist",
        "Artist not found",
        format,
        callback,
    );
    if (!artistId) {
        return;
    }

    const count = parseCountParam(req.query.count, 50, 500);
    const musicFolderId =
        typeof req.query.musicFolderId === "string"
            ? req.query.musicFolderId
            : "";

    if (musicFolderId && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID) {
        sendSubsonicSuccess(
            res,
            {
                similarSongs: {
                    song: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    try {
        const artistExists = await prisma.artist.findFirst({
            where: {
                id: artistId,
                albums: {
                    some: LIBRARY_ALBUM_WHERE,
                },
            },
            select: {
                id: true,
            },
        });

        if (!artistExists) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Artist not found",
                format,
                callback,
            );
            return;
        }

        const similarArtistIds = await findSimilarArtistIds(artistId);
        if (similarArtistIds.length === 0) {
            sendSubsonicSuccess(
                res,
                {
                    similarSongs: {
                        song: [],
                    },
                },
                format,
                callback,
            );
            return;
        }

        const tracks = await prisma.track.findMany({
            where: {
                ...LIBRARY_TRACK_WHERE,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
                    artistId: {
                        in: similarArtistIds,
                    },
                },
            },
            select: similarSongTrackSelect,
            orderBy: [
                { album: { artist: { name: "asc" } } },
                { album: { title: "asc" } },
                { discNo: "asc" },
                { trackNo: "asc" },
                { id: "asc" },
            ],
            take: Math.max(count, Math.min(5000, count * 6)),
        });

        const similarArtistRank = new Map(
            similarArtistIds.map((id, index) => [id, index]),
        );

        const selectedTracks = tracks
            .sort((left, right) => {
                const leftRank =
                    similarArtistRank.get(left.album.artist.id) ??
                    Number.MAX_SAFE_INTEGER;
                const rightRank =
                    similarArtistRank.get(right.album.artist.id) ??
                    Number.MAX_SAFE_INTEGER;
                if (leftRank !== rightRank) {
                    return leftRank - rightRank;
                }

                if (left.album.title !== right.album.title) {
                    return left.album.title.localeCompare(right.album.title);
                }

                if (left.discNo !== right.discNo) {
                    return left.discNo - right.discNo;
                }

                if (left.trackNo !== right.trackNo) {
                    return left.trackNo - right.trackNo;
                }

                return left.id.localeCompare(right.id);
            })
            .slice(0, count);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            selectedTracks.map((track) => track.id),
        );
        const songs = selectedTracks.map((track) =>
            formatSongForSubsonic(track, playedAtByTrackId.get(track.id)),
        );

        sendSubsonicSuccess(
            res,
            {
                similarSongs: {
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
            "Failed to fetch similar songs",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetSimilarSongs2.
 */
export async function handleGetSimilarSongs2(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const trackId = parseEntityIdOrNotFound(
        req,
        res,
        rawId,
        "track",
        "Song not found",
        format,
        callback,
    );
    if (!trackId) {
        return;
    }

    const count = parseCountParam(req.query.count, 50, 500);
    const musicFolderId =
        typeof req.query.musicFolderId === "string"
            ? req.query.musicFolderId
            : "";

    if (musicFolderId && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID) {
        sendSubsonicSuccess(
            res,
            {
                similarSongs2: {
                    song: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    try {
        const sourceTrack = await prisma.track.findFirst({
            where: {
                ...LIBRARY_TRACK_WHERE,
                id: trackId,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
                },
            },
            select: {
                id: true,
                album: {
                    select: {
                        artist: {
                            select: {
                                id: true,
                            },
                        },
                        genres: true,
                        userGenres: true,
                    },
                },
                trackGenres: {
                    select: {
                        genre: {
                            select: {
                                name: true,
                            },
                        },
                    },
                },
            },
        });

        if (!sourceTrack) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }

        const sourceArtistId = sourceTrack.album.artist.id;
        const similarArtistIds = await findSimilarArtistIds(sourceArtistId);
        const genreValues = collectTrackGenreValues(sourceTrack);
        const genreFilter = buildGenreTrackFilter(genreValues);

        const similarArtistTracks =
            similarArtistIds.length > 0
                ? await prisma.track.findMany({
                      where: {
                          ...LIBRARY_TRACK_WHERE,
                          id: {
                              not: trackId,
                          },
                          album: {
                              location: SUBSONIC_ALBUM_LOCATION_WHERE,
                              artistId: {
                                  in: similarArtistIds,
                              },
                          },
                      },
                      select: similarSongTrackSelect,
                      orderBy: [
                          { album: { artist: { name: "asc" } } },
                          { album: { title: "asc" } },
                          { discNo: "asc" },
                          { trackNo: "asc" },
                          { id: "asc" },
                      ],
                      take: Math.max(count, Math.min(5000, count * 6)),
                  })
                : [];

        const genreTracks =
            genreFilter !== null
                ? await prisma.track.findMany({
                      where: {
                          ...LIBRARY_TRACK_WHERE,
                          id: {
                              not: trackId,
                          },
                          album: {
                              location: SUBSONIC_ALBUM_LOCATION_WHERE,
                          },
                          ...genreFilter,
                      },
                      select: similarSongTrackSelect,
                      orderBy: [{ title: "asc" }, { id: "asc" }],
                      take: Math.max(count, Math.min(5000, count * 6)),
                  })
                : [];

        const sameArtistTracks = await prisma.track.findMany({
            where: {
                ...LIBRARY_TRACK_WHERE,
                id: {
                    not: trackId,
                },
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
                    artistId: sourceArtistId,
                },
            },
            select: similarSongTrackSelect,
            orderBy: [
                { album: { title: "asc" } },
                { discNo: "asc" },
                { trackNo: "asc" },
                { id: "asc" },
            ],
            take: Math.max(count, Math.min(5000, count * 2)),
        });

        const mergedTracks = mergeUniqueTracks([
            similarArtistTracks,
            genreTracks,
            sameArtistTracks,
        ]);
        const selectedTracks = mergedTracks.slice(0, count);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            selectedTracks.map((track) => track.id),
        );

        sendSubsonicSuccess(
            res,
            {
                similarSongs2: {
                    song: selectedTracks.map((track) =>
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
            "Failed to fetch similar songs",
            format,
            callback,
        );
    }
}

async function resolveArtistIdForTopSongs(
    rawArtistParam: string,
): Promise<{ id: string; name: string } | null> {
    const normalized = rawArtistParam.trim();
    if (!normalized) {
        return null;
    }

    try {
        const parsed = parseSubsonicId(normalized, "artist");
        const artistById = await prisma.artist.findFirst({
            where: {
                id: parsed.id,
                albums: {
                    some: LIBRARY_ALBUM_WHERE,
                },
            },
            select: {
                id: true,
                name: true,
            },
        });
        if (artistById) {
            return artistById;
        }
    } catch {
        // Fall through to name lookup below when the artist query is not an ID.
    }

    const artistByName = await prisma.artist.findFirst({
        where: {
            name: {
                equals: normalized,
                mode: "insensitive",
            },
            albums: {
                some: LIBRARY_ALBUM_WHERE,
            },
        },
        select: {
            id: true,
            name: true,
        },
    });

    return artistByName ?? null;
}

/**
 * Executes handleGetTopSongs.
 */
export async function handleGetTopSongs(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const artistParam = getRequiredQueryString(
        req,
        res,
        "artist",
        format,
        callback,
    );
    if (!artistParam) {
        return;
    }

    try {
        const artist = await resolveArtistIdForTopSongs(artistParam);
        if (!artist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Artist not found",
                format,
                callback,
            );
            return;
        }

        const trackPlayCounts = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                track: {
                    ...LIBRARY_TRACK_WHERE,
                    album: {
                        artistId: artist.id,
                        location: SUBSONIC_ALBUM_LOCATION_WHERE,
                    },
                },
            },
            _count: {
                _all: true,
            },
        });

        const playCountByTrackId = new Map(
            trackPlayCounts.map((row) => [row.trackId, row._count._all]),
        );

        const tracks = await prisma.track.findMany({
            where: {
                ...LIBRARY_TRACK_WHERE,
                album: {
                    artistId: artist.id,
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
                },
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
        });

        const selectedTracks = tracks
            .sort((left, right) => {
                const leftCount = playCountByTrackId.get(left.id) ?? 0;
                const rightCount = playCountByTrackId.get(right.id) ?? 0;
                if (leftCount !== rightCount) {
                    return rightCount - leftCount;
                }
                if (left.discNo !== right.discNo) {
                    return left.discNo - right.discNo;
                }
                if (left.trackNo !== right.trackNo) {
                    return left.trackNo - right.trackNo;
                }
                return left.title.localeCompare(right.title);
            })
            .slice(0, 50);
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            selectedTracks.map((track) => track.id),
        );
        const topSongs = selectedTracks.map((track) =>
            formatSongForSubsonic(track, playedAtByTrackId.get(track.id)),
        );

        sendSubsonicSuccess(
            res,
            {
                topSongs: {
                    song: topSongs,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch top songs",
            format,
            callback,
        );
    }
}
