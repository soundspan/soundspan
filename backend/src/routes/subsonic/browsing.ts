import { type Request, type Response } from "express";
import { prisma } from "../../utils/db";
import { buildArtistIndexes } from "../../utils/subsonicIndexes";
import {
    parseSubsonicId,
    toSubsonicId,
    type SubsonicEntityType,
} from "../../utils/subsonicIds";
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
    getRequiredQueryString,
    isUnsupportedMusicFolderId,
    LIBRARY_ALBUM_WHERE,
    LIBRARY_TRACK_WHERE,
    parseEntityIdOrNotFound,
    parseTimestampParam,
    SUBSONIC_ALBUM_LOCATION_WHERE,
    SUBSONIC_MUSIC_FOLDER_ID,
} from "./shared";

/**
 * Executes handleGetMusicFolders.
 */
export function handleGetMusicFolders(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(
        res,
        {
            musicFolders: {
                musicFolder: [
                    {
                        id: 1,
                        name: "Music",
                    },
                ],
            },
        },
        format,
        callback,
    );
}

/**
 * Executes handleGetIndexes.
 */
export async function handleGetIndexes(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    if (isUnsupportedMusicFolderId(req.query.musicFolderId)) {
        sendSubsonicSuccess(
            res,
            {
                indexes: buildArtistIndexes([], { lastModified: Date.now() }),
            },
            format,
            callback,
        );
        return;
    }

    try {
        const artists = await prisma.artist.findMany({
            where: {
                albums: {
                    some: LIBRARY_ALBUM_WHERE,
                },
            },
            select: {
                id: true,
                name: true,
                heroUrl: true,
                lastSynced: true,
                _count: {
                    select: {
                        albums: { where: LIBRARY_ALBUM_WHERE },
                    },
                },
            },
            orderBy: { name: "asc" },
        });

        const lastModified =
            artists.reduce((latest, artist) => {
                const syncedAt = artist.lastSynced?.getTime() ?? 0;
                return Math.max(latest, syncedAt);
            }, 0) || Date.now();
        const ifModifiedSince = parseTimestampParam(req.query.ifModifiedSince);

        if (ifModifiedSince !== null && ifModifiedSince >= lastModified) {
            sendSubsonicSuccess(
                res,
                {
                    indexes: buildArtistIndexes([], { lastModified }),
                },
                format,
                callback,
            );
            return;
        }

        const indexes = buildArtistIndexes(
            artists.map((artist) => ({
                id: artist.id,
                name: artist.name,
                albumCount: artist._count.albums,
                coverArtId: artist.heroUrl
                    ? toSubsonicId("artist", artist.id)
                    : undefined,
            })),
            { lastModified },
        );

        sendSubsonicSuccess(
            res,
            {
                indexes,
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch indexes",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetArtists.
 */
export async function handleGetArtists(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    if (isUnsupportedMusicFolderId(req.query.musicFolderId)) {
        sendSubsonicSuccess(
            res,
            {
                artists: {
                    ignoredArticles: buildArtistIndexes([]).ignoredArticles,
                    index: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    try {
        const artists = await prisma.artist.findMany({
            where: {
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
                        albums: { where: LIBRARY_ALBUM_WHERE },
                    },
                },
            },
            orderBy: { name: "asc" },
        });

        const indexes = buildArtistIndexes(
            artists.map((artist) => ({
                id: artist.id,
                name: artist.name,
                albumCount: artist._count.albums,
                coverArtId: artist.heroUrl
                    ? toSubsonicId("artist", artist.id)
                    : undefined,
            })),
        );

        sendSubsonicSuccess(
            res,
            {
                artists: {
                    ignoredArticles: indexes.ignoredArticles,
                    index: indexes.index,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch artists",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetArtist.
 */
export async function handleGetArtist(
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

    try {
        const artist = await prisma.artist.findFirst({
            where: {
                id: artistId,
                albums: {
                    some: LIBRARY_ALBUM_WHERE,
                },
            },
            select: {
                id: true,
                name: true,
                heroUrl: true,
                albums: {
                    where: LIBRARY_ALBUM_WHERE,
                    select: {
                        id: true,
                        title: true,
                        year: true,
                        lastSynced: true,
                        coverUrl: true,
                        genres: true,
                        userGenres: true,
                        tracks: {
                            where: LIBRARY_TRACK_WHERE,
                            select: {
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
                    orderBy: [{ year: "desc" }, { title: "asc" }],
                },
            },
        });

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

        const albums = artist.albums.map((album) =>
            formatAlbumForSubsonic({
                id: album.id,
                title: album.title,
                year: album.year,
                lastSynced: album.lastSynced,
                coverUrl: album.coverUrl,
                genres: album.genres,
                userGenres: album.userGenres,
                artist: {
                    id: artist.id,
                    name: artist.name,
                },
                songCount: album._count.tracks,
                duration: album.tracks.reduce(
                    (sum, track) => sum + (track.duration ?? 0),
                    0,
                ),
            }),
        );

        sendSubsonicSuccess(
            res,
            {
                artist: {
                    ...formatArtistForSubsonic({
                        id: artist.id,
                        name: artist.name,
                        albumCount: artist.albums.length,
                        heroUrl: artist.heroUrl,
                    }),
                    album: albums,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch artist",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetAlbum.
 */
export async function handleGetAlbum(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const albumId = parseEntityIdOrNotFound(
        req,
        res,
        rawId,
        "album",
        "Album not found",
        format,
        callback,
    );
    if (!albumId) {
        return;
    }

    try {
        const album = await prisma.album.findFirst({
            where: {
                id: albumId,
                ...LIBRARY_ALBUM_WHERE,
            },
            select: {
                id: true,
                title: true,
                year: true,
                lastSynced: true,
                coverUrl: true,
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
                        title: true,
                        trackNo: true,
                        discNo: true,
                        duration: true,
                        fileSize: true,
                        mime: true,
                        filePath: true,
                    },
                    orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
                },
            },
        });

        if (!album) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Album not found",
                format,
                callback,
            );
            return;
        }

        const songs = album.tracks.map((track) =>
            formatSongForSubsonic({
                ...track,
                album: {
                    id: album.id,
                    title: album.title,
                    year: album.year,
                    coverUrl: album.coverUrl,
                    genres: album.genres,
                    userGenres: album.userGenres,
                    artist: album.artist,
                },
            }),
        );

        sendSubsonicSuccess(
            res,
            {
                album: {
                    ...formatAlbumForSubsonic({
                        id: album.id,
                        title: album.title,
                        year: album.year,
                        lastSynced: album.lastSynced,
                        coverUrl: album.coverUrl,
                        genres: album.genres,
                        userGenres: album.userGenres,
                        artist: album.artist,
                        songCount: album.tracks.length,
                        duration: album.tracks.reduce(
                            (sum, track) => sum + (track.duration ?? 0),
                            0,
                        ),
                    }),
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
            "Failed to fetch album",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetSong.
 */
export async function handleGetSong(
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

    try {
        const track = await prisma.track.findFirst({
            where: {
                ...LIBRARY_TRACK_WHERE,
                id: trackId,
                album: {
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
                album: {
                    select: {
                        id: true,
                        title: true,
                        year: true,
                        coverUrl: true,
                        genres: true,
                        userGenres: true,
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

        if (!track) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }

        sendSubsonicSuccess(
            res,
            {
                song: formatSongForSubsonic(track),
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch song",
            format,
            callback,
        );
    }
}
/**
 * Executes handleGetArtistInfo2.
 */
export async function handleGetArtistInfo2(
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

    try {
        const artist = await prisma.artist.findFirst({
            where: {
                id: artistId,
                albums: {
                    some: LIBRARY_ALBUM_WHERE,
                },
            },
            select: {
                id: true,
                name: true,
                mbid: true,
                summary: true,
                heroUrl: true,
                similarFrom: {
                    select: {
                        weight: true,
                        toArtist: {
                            select: {
                                id: true,
                                name: true,
                                heroUrl: true,
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
                    take: 20,
                },
            },
        });

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

        const similarArtist = artist.similarFrom
            .map((entry) => entry.toArtist)
            .filter((similar) => similar.albums.length > 0)
            .map((similar) =>
                formatArtistForSubsonic({
                    id: similar.id,
                    name: similar.name,
                    albumCount: similar.albums.length,
                    heroUrl: similar.heroUrl,
                }),
            );

        sendSubsonicSuccess(
            res,
            {
                artistInfo2: {
                    biography: artist.summary ?? "",
                    musicBrainzId: artist.mbid,
                    smallImageUrl: artist.heroUrl ?? undefined,
                    mediumImageUrl: artist.heroUrl ?? undefined,
                    largeImageUrl: artist.heroUrl ?? undefined,
                    similarArtist,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch artist info",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetAlbumInfo2.
 */
export async function handleGetAlbumInfo2(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const albumId = parseEntityIdOrNotFound(
        req,
        res,
        rawId,
        "album",
        "Album not found",
        format,
        callback,
    );
    if (!albumId) {
        return;
    }

    try {
        const album = await prisma.album.findFirst({
            where: {
                id: albumId,
                ...LIBRARY_ALBUM_WHERE,
            },
            select: {
                rgMbid: true,
                title: true,
                coverUrl: true,
                genres: true,
                userGenres: true,
            },
        });

        if (!album) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Album not found",
                format,
                callback,
            );
            return;
        }

        sendSubsonicSuccess(
            res,
            {
                albumInfo: {
                    notes: album.title,
                    musicBrainzId: album.rgMbid,
                    smallImageUrl: album.coverUrl ?? undefined,
                    mediumImageUrl: album.coverUrl ?? undefined,
                    largeImageUrl: album.coverUrl ?? undefined,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch album info",
            format,
            callback,
        );
    }
}
async function getRootMusicDirectoryChildren(): Promise<
    Record<string, unknown>[]
> {
    const artists = await prisma.artist.findMany({
        where: {
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
        orderBy: {
            name: "asc",
        },
    });

    return artists.map((artist) => ({
        ...formatArtistForSubsonic({
            id: artist.id,
            name: artist.name,
            albumCount: artist._count.albums,
            heroUrl: artist.heroUrl,
        }),
        parent: SUBSONIC_MUSIC_FOLDER_ID,
        isDir: true,
        title: artist.name,
        artist: artist.name,
    }));
}

async function getArtistMusicDirectory(
    artistId: string,
): Promise<Record<string, unknown> | null> {
    const artist = await prisma.artist.findFirst({
        where: {
            id: artistId,
            albums: {
                some: LIBRARY_ALBUM_WHERE,
            },
        },
        select: {
            id: true,
            name: true,
            albums: {
                where: LIBRARY_ALBUM_WHERE,
                select: {
                    id: true,
                    title: true,
                    year: true,
                    lastSynced: true,
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    tracks: {
                        where: LIBRARY_TRACK_WHERE,
                        select: {
                            duration: true,
                        },
                    },
                },
                orderBy: [{ year: "desc" }, { title: "asc" }],
            },
        },
    });

    if (!artist) {
        return null;
    }

    return {
        id: toSubsonicId("artist", artist.id),
        parent: SUBSONIC_MUSIC_FOLDER_ID,
        name: artist.name,
        child: artist.albums.map((album) =>
            formatAlbumForSubsonic({
                id: album.id,
                title: album.title,
                year: album.year,
                lastSynced: album.lastSynced,
                coverUrl: album.coverUrl,
                genres: album.genres,
                userGenres: album.userGenres,
                artist: {
                    id: artist.id,
                    name: artist.name,
                },
                songCount: album.tracks.length,
                duration: album.tracks.reduce(
                    (sum, track) => sum + (track.duration ?? 0),
                    0,
                ),
            }),
        ),
    };
}

async function getAlbumMusicDirectory(
    albumId: string,
): Promise<Record<string, unknown> | null> {
    const album = await prisma.album.findFirst({
        where: {
            id: albumId,
            ...LIBRARY_ALBUM_WHERE,
        },
        select: {
            id: true,
            title: true,
            year: true,
            coverUrl: true,
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
                    title: true,
                    trackNo: true,
                    discNo: true,
                    duration: true,
                    fileSize: true,
                    mime: true,
                    filePath: true,
                },
                orderBy: [{ discNo: "asc" }, { trackNo: "asc" }, { id: "asc" }],
            },
        },
    });

    if (!album) {
        return null;
    }

    return {
        id: toSubsonicId("album", album.id),
        parent: toSubsonicId("artist", album.artist.id),
        name: album.title,
        child: album.tracks.map((track) =>
            formatSongForSubsonic({
                ...track,
                album: {
                    id: album.id,
                    title: album.title,
                    year: album.year,
                    coverUrl: album.coverUrl,
                    genres: album.genres,
                    userGenres: album.userGenres,
                    artist: album.artist,
                },
            }),
        ),
    };
}

/**
 * Executes handleGetMusicDirectory.
 */
export async function handleGetMusicDirectory(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    if (rawId === SUBSONIC_MUSIC_FOLDER_ID) {
        try {
            sendSubsonicSuccess(
                res,
                {
                    directory: {
                        id: SUBSONIC_MUSIC_FOLDER_ID,
                        name: "Music",
                        child: await getRootMusicDirectoryChildren(),
                    },
                },
                format,
                callback,
            );
        } catch {
            sendSubsonicError(
                res,
                SubsonicErrorCode.GENERIC,
                "Failed to fetch directory",
                format,
                callback,
            );
        }
        return;
    }

    let parsedType: SubsonicEntityType | null = null;
    let entityId = rawId;

    try {
        const parsed = parseSubsonicId(rawId);
        parsedType = parsed.type;
        entityId = parsed.id;
    } catch {
        parsedType = null;
        entityId = rawId.trim();
    }

    try {
        let directory: Record<string, unknown> | null = null;

        if (parsedType === "artist") {
            directory = await getArtistMusicDirectory(entityId);
        } else if (parsedType === "album") {
            directory = await getAlbumMusicDirectory(entityId);
        } else if (parsedType === null) {
            directory = await getArtistMusicDirectory(entityId);
            if (!directory) {
                directory = await getAlbumMusicDirectory(entityId);
            }
        }

        if (!directory) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Directory not found",
                format,
                callback,
            );
            return;
        }

        sendSubsonicSuccess(
            res,
            {
                directory,
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch directory",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetGenres.
 */
export async function handleGetGenres(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const genres = await prisma.genre.findMany({
            where: {
                trackGenres: {
                    some: {
                        track: {
                            ...LIBRARY_TRACK_WHERE,
                            album: {
                                location: SUBSONIC_ALBUM_LOCATION_WHERE,
                            },
                        },
                    },
                },
            },
            select: {
                name: true,
                trackGenres: {
                    where: {
                        track: {
                            ...LIBRARY_TRACK_WHERE,
                            album: {
                                location: SUBSONIC_ALBUM_LOCATION_WHERE,
                            },
                        },
                    },
                    select: {
                        track: {
                            select: {
                                albumId: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                name: "asc",
            },
        });

        sendSubsonicSuccess(
            res,
            {
                genres: {
                    genre: genres.map((genre) => ({
                        value: genre.name,
                        songCount: genre.trackGenres.length,
                        albumCount: new Set(
                            genre.trackGenres.map(
                                (entry) => entry.track.albumId,
                            ),
                        ).size,
                    })),
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch genres",
            format,
            callback,
        );
    }
}
