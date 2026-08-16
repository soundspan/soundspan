import { type Request, type Response } from "express";
import { prisma } from "../../utils/db";
import { parseSubsonicId, toSubsonicId } from "../../utils/subsonicIds";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    ensureLibraryTracksExist,
    formatSongForSubsonic,
    getQueryValues,
    getRequestContext,
    getRequiredQueryString,
    parseTrackIdsFromQueryValues,
    PLAYLIST_TRACK_WHERE,
} from "./shared";

async function getPlaylistDurations(
    playlists: Array<{ id: string; _count: { items: number } }>,
): Promise<Map<string, number>> {
    const nonEmptyIds = playlists
        .filter((playlist) => playlist._count.items > 0)
        .map((playlist) => playlist.id);
    if (nonEmptyIds.length === 0) {
        return new Map();
    }
    const rows = await prisma.playlistItem.findMany({
        where: {
            playlistId: { in: nonEmptyIds },
            trackId: { not: null },
            track: PLAYLIST_TRACK_WHERE,
        },
        select: {
            playlistId: true,
            track: { select: { duration: true } },
        },
    });
    const durations = new Map<string, number>();
    for (const row of rows) {
        durations.set(
            row.playlistId,
            (durations.get(row.playlistId) ?? 0) + (row.track?.duration ?? 0),
        );
    }
    return durations;
}

async function getPlaylistCoverFlags(
    playlistIds: string[],
): Promise<Set<string>> {
    if (playlistIds.length === 0) {
        return new Set();
    }
    const rows = await prisma.playlistItem.findMany({
        where: {
            playlistId: { in: playlistIds },
            track: {
                ...PLAYLIST_TRACK_WHERE,
                album: {
                    AND: [
                        { coverUrl: { not: null } },
                        { coverUrl: { not: "" } },
                    ],
                },
            },
        },
        distinct: ["playlistId"],
        select: { playlistId: true },
    });
    return new Set(rows.map((row) => row.playlistId));
}

/**
 * Executes handleGetPlaylists.
 */
export async function handleGetPlaylists(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const playlists = await prisma.playlist.findMany({
            where: {
                userId: req.user!.id,
            },
            orderBy: {
                createdAt: "desc",
            },
            include: {
                _count: {
                    select: {
                        items: {
                            where: {
                                OR: [
                                    { trackId: null },
                                    {
                                        track: {
                                            ...PLAYLIST_TRACK_WHERE,
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const playlistIds = playlists.map((playlist) => playlist.id);
        const [durations, coverFlags] = await Promise.all([
            getPlaylistDurations(playlists),
            getPlaylistCoverFlags(playlistIds),
        ]);

        sendSubsonicSuccess(
            res,
            {
                playlists: {
                    playlist: playlists.map((playlist) => ({
                        id: toSubsonicId("playlist", playlist.id),
                        name: playlist.name,
                        songCount: playlist._count.items,
                        duration: durations.get(playlist.id) ?? 0,
                        public: playlist.isPublic,
                        owner: req.user!.username,
                        created: playlist.createdAt.toISOString(),
                        changed: playlist.createdAt.toISOString(),
                        coverArt: coverFlags.has(playlist.id)
                            ? toSubsonicId("playlist", playlist.id)
                            : undefined,
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
            "Failed to fetch playlists",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetPlaylist.
 */
export async function handleGetPlaylist(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    let playlistId: string;
    try {
        playlistId = parseSubsonicId(rawId, "playlist").id;
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Playlist not found",
            format,
            callback,
        );
        return;
    }

    try {
        const playlist = await prisma.playlist.findFirst({
            where: {
                id: playlistId,
                userId: req.user!.id,
            },
            include: {
                items: {
                    where: { track: PLAYLIST_TRACK_WHERE },
                    orderBy: { sort: "asc" },
                    select: {
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
                        },
                    },
                },
            },
        });

        if (!playlist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Playlist not found",
                format,
                callback,
            );
            return;
        }

        const libraryTracks = playlist.items.flatMap((item) =>
            item.track ? [item.track] : [],
        );
        const entries = libraryTracks.map((track) =>
            formatSongForSubsonic(track),
        );
        const duration = libraryTracks.reduce(
            (sum, track) => sum + (track.duration ?? 0),
            0,
        );
        const hasCover = libraryTracks.some((track) =>
            Boolean(track.album.coverUrl),
        );

        sendSubsonicSuccess(
            res,
            {
                playlist: {
                    id: toSubsonicId("playlist", playlist.id),
                    name: playlist.name,
                    songCount: entries.length,
                    duration,
                    public: playlist.isPublic,
                    owner: req.user!.username,
                    created: playlist.createdAt.toISOString(),
                    changed: playlist.createdAt.toISOString(),
                    coverArt: hasCover
                        ? toSubsonicId("playlist", playlist.id)
                        : undefined,
                    entry: entries,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch playlist",
            format,
            callback,
        );
    }
}

/**
 * Executes handleCreatePlaylist.
 */
export async function handleCreatePlaylist(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawPlaylistId =
        typeof req.query.playlistId === "string" ? req.query.playlistId : "";
    const rawName =
        typeof req.query.name === "string" ? req.query.name.trim() : "";
    const rawSongIds = getQueryValues(req.query.songId);

    if (!rawPlaylistId && !rawName) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'name' or 'playlistId' is missing",
            format,
            callback,
        );
        return;
    }

    let trackIds: string[] = [];
    try {
        trackIds = parseTrackIdsFromQueryValues(rawSongIds);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Song not found",
            format,
            callback,
        );
        return;
    }

    try {
        const tracksExist = await ensureLibraryTracksExist(trackIds);
        if (!tracksExist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }

        if (rawPlaylistId) {
            const playlistId = parseSubsonicId(rawPlaylistId, "playlist").id;
            const existing = await prisma.playlist.findFirst({
                where: {
                    id: playlistId,
                    userId: req.user!.id,
                },
                select: {
                    id: true,
                },
            });

            if (!existing) {
                sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_AUTHORIZED,
                    "Not authorized to modify this playlist",
                    format,
                    callback,
                );
                return;
            }

            if (rawName) {
                await prisma.playlist.update({
                    where: {
                        id: playlistId,
                    },
                    data: {
                        name: rawName,
                    },
                });
            }

            if (trackIds.length > 0) {
                await prisma.playlistItem.deleteMany({
                    where: {
                        playlistId,
                    },
                });

                await prisma.playlistItem.createMany({
                    data: trackIds.map((trackId, index) => ({
                        playlistId,
                        trackId,
                        sort: index,
                    })),
                    skipDuplicates: true,
                });
            }

            sendSubsonicSuccess(res, {}, format, callback);
            return;
        }

        const playlist = await prisma.playlist.create({
            data: {
                userId: req.user!.id,
                name: rawName,
            },
        });

        if (trackIds.length > 0) {
            await prisma.playlistItem.createMany({
                data: trackIds.map((trackId, index) => ({
                    playlistId: playlist.id,
                    trackId,
                    sort: index,
                })),
                skipDuplicates: true,
            });
        }

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to create/update playlist",
            format,
            callback,
        );
    }
}

/**
 * Executes handleUpdatePlaylist.
 */
export async function handleUpdatePlaylist(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawPlaylistId = getRequiredQueryString(
        req,
        res,
        "playlistId",
        format,
        callback,
    );
    if (!rawPlaylistId) {
        return;
    }

    const rawName =
        typeof req.query.name === "string" ? req.query.name.trim() : "";
    const rawSongIdsToAdd = getQueryValues(req.query.songIdToAdd);
    const rawSongIndexesToRemove = getQueryValues(req.query.songIndexToRemove);

    let playlistId: string;
    try {
        playlistId = parseSubsonicId(rawPlaylistId, "playlist").id;
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Playlist not found",
            format,
            callback,
        );
        return;
    }

    try {
        const playlist = await prisma.playlist.findFirst({
            where: {
                id: playlistId,
                userId: req.user!.id,
            },
            select: {
                id: true,
            },
        });

        if (!playlist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_AUTHORIZED,
                "Not authorized to modify this playlist",
                format,
                callback,
            );
            return;
        }

        if (rawName) {
            await prisma.playlist.update({
                where: {
                    id: playlistId,
                },
                data: {
                    name: rawName,
                },
            });
        }

        if (rawSongIndexesToRemove.length > 0) {
            const indexesToRemove = Array.from(
                new Set(
                    rawSongIndexesToRemove
                        .map((value) => Number.parseInt(value, 10))
                        .filter(
                            (value) => Number.isInteger(value) && value >= 0,
                        ),
                ),
            );

            const currentItems = await prisma.playlistItem.findMany({
                where: {
                    playlistId,
                },
                orderBy: {
                    sort: "asc",
                },
                select: {
                    id: true,
                },
            });

            const itemIdsToDelete = indexesToRemove
                .filter((index) => index < currentItems.length)
                .map((index) => currentItems[index].id);

            if (itemIdsToDelete.length > 0) {
                await prisma.playlistItem.deleteMany({
                    where: {
                        id: {
                            in: itemIdsToDelete,
                        },
                    },
                });
            }
        }

        if (rawSongIdsToAdd.length > 0) {
            let trackIdsToAdd: string[] = [];
            try {
                trackIdsToAdd = parseTrackIdsFromQueryValues(rawSongIdsToAdd);
            } catch {
                sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Song not found",
                    format,
                    callback,
                );
                return;
            }

            const tracksExist = await ensureLibraryTracksExist(trackIdsToAdd);
            if (!tracksExist) {
                sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Song not found",
                    format,
                    callback,
                );
                return;
            }

            const [existingItems, maxSortResult] = await Promise.all([
                prisma.playlistItem.findMany({
                    where: {
                        playlistId,
                    },
                    select: {
                        trackId: true,
                    },
                }),
                prisma.playlistItem.aggregate({
                    where: {
                        playlistId,
                    },
                    _max: {
                        sort: true,
                    },
                }),
            ]);

            const existingTrackIds = new Set(
                existingItems.map((item) => item.trackId),
            );
            const filteredTrackIds = trackIdsToAdd.filter(
                (trackId) => !existingTrackIds.has(trackId),
            );

            if (filteredTrackIds.length > 0) {
                const startSort = (maxSortResult._max.sort ?? -1) + 1;
                await prisma.playlistItem.createMany({
                    data: filteredTrackIds.map((trackId, index) => ({
                        playlistId,
                        trackId,
                        sort: startSort + index,
                    })),
                    skipDuplicates: true,
                });
            }
        }

        const itemsToReindex = await prisma.playlistItem.findMany({
            where: {
                playlistId,
            },
            orderBy: {
                sort: "asc",
            },
            select: {
                id: true,
            },
        });

        if (itemsToReindex.length > 0) {
            await prisma.$transaction(
                itemsToReindex.map((item, index) =>
                    prisma.playlistItem.update({
                        where: {
                            id: item.id,
                        },
                        data: {
                            sort: index,
                        },
                    }),
                ),
            );
        }

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to update playlist",
            format,
            callback,
        );
    }
}

/**
 * Executes handleDeletePlaylist.
 */
export async function handleDeletePlaylist(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    let playlistId: string;
    try {
        playlistId = parseSubsonicId(rawId, "playlist").id;
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Playlist not found",
            format,
            callback,
        );
        return;
    }

    try {
        const playlist = await prisma.playlist.findFirst({
            where: {
                id: playlistId,
                userId: req.user!.id,
            },
            select: {
                id: true,
            },
        });

        if (!playlist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_AUTHORIZED,
                "Not authorized to delete this playlist",
                format,
                callback,
            );
            return;
        }

        await prisma.playlist.delete({
            where: {
                id: playlistId,
            },
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to delete playlist",
            format,
            callback,
        );
    }
}
