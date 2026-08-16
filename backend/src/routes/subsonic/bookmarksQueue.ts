import { type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { parseSubsonicId, toSubsonicId } from "../../utils/subsonicIds";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    bookmarkTrackSelect,
    ensureLibraryTracksExist,
    formatBookmarkForSubsonic,
    formatSongForSubsonic,
    getQueryValues,
    getRequestContext,
    getRequiredQueryString,
    LIBRARY_TRACK_WHERE,
    parseBookmarkPositionOrError,
    parseEntityIdOrNotFound,
    parseTrackIdsPreserveOrder,
    SUBSONIC_ALBUM_LOCATION_WHERE,
} from "./shared";

function parseQueueIndex(value: unknown): number {
    if (typeof value !== "string") {
        return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return 0;
    }

    return Math.max(0, parsed);
}

function parseQueuePositionMs(value: unknown): number {
    if (typeof value !== "string") {
        return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return 0;
    }

    return Math.max(0, parsed);
}

function parsePlaybackDeviceIndex(value: unknown): number {
    if (typeof value !== "string") {
        return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return 0;
    }

    return Math.max(0, Math.min(parsed, 100));
}

function getLegacyPlaybackDeviceId(playbackIndex = 0): string {
    if (playbackIndex === 0) {
        return "legacy";
    }

    return `legacy-${playbackIndex}`;
}
/**
 * Executes handleGetPlayQueue.
 */
export async function handleGetPlayQueue(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const playbackIndex = parsePlaybackDeviceIndex(req.query.index);
    const deviceId = getLegacyPlaybackDeviceId(playbackIndex);

    try {
        const state = await prisma.playbackState.findUnique({
            where: {
                userId_deviceId: {
                    userId: req.user!.id,
                    deviceId,
                },
            },
        });

        const queueItems = Array.isArray(state?.queue) ? state.queue : [];

        const queueTrackIds = queueItems
            .map((item) =>
                typeof item === "object" &&
                item !== null &&
                "id" in item &&
                typeof (item as { id?: unknown }).id === "string"
                    ? (item as { id: string }).id
                    : null,
            )
            .filter((id): id is string => Boolean(id))
            .map((id) => {
                try {
                    return parseSubsonicId(id, "track").id;
                } catch {
                    return id;
                }
            });

        const uniqueTrackIds = Array.from(new Set(queueTrackIds));
        const tracks =
            uniqueTrackIds.length > 0
                ? await prisma.track.findMany({
                      where: {
                          ...LIBRARY_TRACK_WHERE,
                          id: {
                              in: uniqueTrackIds,
                          },
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
                  })
                : [];

        const trackById = new Map(tracks.map((track) => [track.id, track]));
        const entry = queueTrackIds
            .map((trackId) => trackById.get(trackId))
            .filter((track): track is NonNullable<typeof track> =>
                Boolean(track),
            )
            .map((track) => formatSongForSubsonic(track));

        const current = Math.min(
            Math.max(0, state?.currentIndex ?? 0),
            entry.length > 0 ? entry.length - 1 : 0,
        );
        const position = Math.max(
            0,
            Math.round((state?.currentTime ?? 0) * 1000),
        );

        sendSubsonicSuccess(
            res,
            {
                playQueue: {
                    current,
                    position,
                    username: req.user!.username,
                    changed: state?.updatedAt.toISOString(),
                    entry,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch play queue",
            format,
            callback,
        );
    }
}

/**
 * Executes handleSavePlayQueue.
 */
export async function handleSavePlayQueue(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const playbackIndex = parsePlaybackDeviceIndex(req.query.index);
    const deviceId = getLegacyPlaybackDeviceId(playbackIndex);
    const rawIds = getQueryValues(req.query.id);
    const rawCurrent = req.query.current;
    const rawPosition = req.query.position;

    let trackIds: string[] = [];
    try {
        trackIds = parseTrackIdsPreserveOrder(rawIds);
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
        const uniqueTrackIds = Array.from(new Set(trackIds));
        const tracksExist = await ensureLibraryTracksExist(uniqueTrackIds);
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

        const tracks =
            uniqueTrackIds.length > 0
                ? await prisma.track.findMany({
                      where: {
                          ...LIBRARY_TRACK_WHERE,
                          id: {
                              in: uniqueTrackIds,
                          },
                          album: {
                              location: SUBSONIC_ALBUM_LOCATION_WHERE,
                          },
                      },
                      select: {
                          id: true,
                          title: true,
                          duration: true,
                          album: {
                              select: {
                                  id: true,
                                  title: true,
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
                  })
                : [];

        const trackById = new Map(tracks.map((track) => [track.id, track]));
        const queue = trackIds
            .map((trackId) => trackById.get(trackId))
            .filter((track): track is NonNullable<typeof track> =>
                Boolean(track),
            )
            .map((track) => ({
                id: toSubsonicId("track", track.id),
                title: track.title,
                duration: track.duration,
                artist: {
                    id: toSubsonicId("artist", track.album.artist.id),
                    name: track.album.artist.name,
                },
                album: {
                    id: toSubsonicId("album", track.album.id),
                    title: track.album.title,
                    coverArt: track.album.coverUrl ?? null,
                },
            }));

        const requestedCurrent = parseQueueIndex(rawCurrent);
        const requestedPositionMs = parseQueuePositionMs(rawPosition);
        const currentIndex = Math.min(
            requestedCurrent,
            queue.length > 0 ? queue.length - 1 : 0,
        );
        const currentTrackId =
            queue.length > 0
                ? parseSubsonicId(queue[currentIndex].id, "track").id
                : null;

        await prisma.playbackState.upsert({
            where: {
                userId_deviceId: {
                    userId: req.user!.id,
                    deviceId,
                },
            },
            update: {
                playbackType: "track",
                trackId: currentTrackId,
                queue: queue.length > 0 ? queue : Prisma.DbNull,
                currentIndex,
                currentTime: requestedPositionMs / 1000,
                isShuffle: false,
            },
            create: {
                userId: req.user!.id,
                deviceId,
                playbackType: "track",
                trackId: currentTrackId,
                queue: queue.length > 0 ? queue : Prisma.DbNull,
                currentIndex,
                currentTime: requestedPositionMs / 1000,
                isShuffle: false,
            },
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to save play queue",
            format,
            callback,
        );
    }
}

/**
 * Executes handleGetPlayQueueByIndex.
 */
export async function handleGetPlayQueueByIndex(
    req: Request,
    res: Response,
): Promise<void> {
    await handleGetPlayQueue(req, res);
}

/**
 * Executes handleSavePlayQueueByIndex.
 */
export async function handleSavePlayQueueByIndex(
    req: Request,
    res: Response,
): Promise<void> {
    await handleSavePlayQueue(req, res);
}

/**
 * Executes handleGetBookmarks.
 */
export async function handleGetBookmarks(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    try {
        const bookmarks = await prisma.bookmark.findMany({
            where: {
                userId: req.user!.id,
                track: LIBRARY_TRACK_WHERE,
            },
            select: {
                positionSeconds: true,
                comment: true,
                createdAt: true,
                updatedAt: true,
                track: {
                    select: bookmarkTrackSelect,
                },
            },
            orderBy: [{ updatedAt: "desc" }, { trackId: "asc" }],
        });

        sendSubsonicSuccess(
            res,
            {
                bookmarks: {
                    bookmark: bookmarks.map((bookmark) =>
                        formatBookmarkForSubsonic(bookmark, req.user!.username),
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
            "Failed to load bookmarks",
            format,
            callback,
        );
    }
}

/**
 * Executes handleCreateBookmark.
 */
export async function handleCreateBookmark(
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

    const positionSeconds = parseBookmarkPositionOrError(
        req,
        res,
        format,
        callback,
    );
    if (positionSeconds === null) {
        return;
    }

    try {
        const track = await prisma.track.findUnique({
            where: {
                ...LIBRARY_TRACK_WHERE,
                id: trackId,
            },
            select: {
                id: true,
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

        await prisma.bookmark.upsert({
            where: {
                userId_trackId: {
                    userId: req.user!.id,
                    trackId,
                },
            },
            create: {
                userId: req.user!.id,
                trackId,
                positionSeconds,
            },
            update: {
                positionSeconds,
            },
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to save bookmark",
            format,
            callback,
        );
    }
}

/**
 * Executes handleDeleteBookmark.
 */
export async function handleDeleteBookmark(
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
        await prisma.bookmark.deleteMany({
            where: {
                userId: req.user!.id,
                trackId,
            },
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to delete bookmark",
            format,
            callback,
        );
    }
}
