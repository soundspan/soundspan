import type { Prisma } from "@prisma/client";
import { type Request, type Response } from "express";
import { prisma } from "../../utils/db";
import {
    PlaylistMutationLockNotFoundError,
    requirePlaylistMutationLock,
} from "../../services/playlistMutationLock";
import { standardPlaylistListWhere } from "../../services/radioPlaylistIdentity";
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
    loadSongEnrichmentByTrackId,
    parseTrackIdsFromQueryValues,
    PLAYLIST_TRACK_WHERE,
    SONG_LOUDNESS_ALBUM_SELECT,
    SONG_LOUDNESS_TRACK_SELECT,
} from "./shared";

type PlaylistMutationResult = "ok" | "trackNotFound";

const PLAYLIST_TRANSACTION_MAX_WAIT_MS = 2_000;
const PLAYLIST_TRANSACTION_TIMEOUT_MS = 15_000;

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
            where: standardPlaylistListWhere(req.user!.id),
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
                                ...SONG_LOUDNESS_TRACK_SELECT,
                                album: {
                                    select: {
                                        id: true,
                                        title: true,
                                        year: true,
                                        coverUrl: true,
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
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            libraryTracks.map((track) => track.id),
        );
        const entries = libraryTracks.map((track) =>
            formatSongForSubsonic(track, playedAtByTrackId.get(track.id)),
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

async function replaceLockedPlaylistItems(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    name: string,
    trackIds: string[],
): Promise<void> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    if (name) {
        await tx.playlist.update({
            where: { id: playlistId },
            data: { name },
        });
    }
    if (trackIds.length > 0) {
        await tx.playlistItem.deleteMany({ where: { playlistId } });
        await tx.playlistItem.createMany({
            data: trackIds.map((trackId, sort) => ({
                playlistId,
                trackId,
                sort,
            })),
            skipDuplicates: true,
        });
    }
}

function sendPlaylistMutationNotAuthorized(
    res: Response,
    format: ReturnType<typeof getRequestContext>["format"],
    callback: string | undefined,
): void {
    sendSubsonicError(
        res,
        SubsonicErrorCode.NOT_AUTHORIZED,
        "Not authorized to modify this playlist",
        format,
        callback,
    );
}

function sendPlaylistTrackNotFound(
    res: Response,
    format: ReturnType<typeof getRequestContext>["format"],
    callback: string | undefined,
): void {
    sendSubsonicError(
        res,
        SubsonicErrorCode.NOT_FOUND,
        "Song not found",
        format,
        callback,
    );
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
            sendPlaylistTrackNotFound(res, format, callback);
            return;
        }

        if (rawPlaylistId) {
            const playlistId = parseSubsonicId(rawPlaylistId, "playlist").id;
            await prisma.$transaction((tx) =>
                replaceLockedPlaylistItems(
                    tx,
                    playlistId,
                    req.user!.id,
                    rawName,
                    trackIds,
                ),
            );
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
    } catch (error) {
        if (error instanceof PlaylistMutationLockNotFoundError) {
            sendPlaylistMutationNotAuthorized(res, format, callback);
            return;
        }
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to create/update playlist",
            format,
            callback,
        );
    }
}

function parseRemovalIndexes(rawIndexes: string[]): number[] {
    return Array.from(
        new Set(
            rawIndexes
                .map((value) => Number.parseInt(value, 10))
                .filter((value) => Number.isInteger(value) && value >= 0),
        ),
    );
}

async function removeLockedPlaylistIndexes(
    tx: Prisma.TransactionClient,
    playlistId: string,
    rawIndexes: string[],
): Promise<boolean> {
    if (rawIndexes.length === 0) return false;
    const currentItems = await tx.playlistItem.findMany({
        where: { playlistId },
        orderBy: { sort: "asc" },
        select: { id: true },
    });
    const itemIds = parseRemovalIndexes(rawIndexes)
        .filter((index) => index < currentItems.length)
        .map((index) => currentItems[index].id);
    if (itemIds.length === 0) return false;
    await tx.playlistItem.deleteMany({
        where: { id: { in: itemIds } },
    });
    return true;
}

async function appendLockedPlaylistTracks(
    tx: Prisma.TransactionClient,
    playlistId: string,
    trackIds: string[],
): Promise<boolean> {
    if (trackIds.length === 0) return false;
    const [existingItems, maximum] = await Promise.all([
        tx.playlistItem.findMany({
            where: { playlistId },
            select: { trackId: true },
        }),
        tx.playlistItem.aggregate({
            where: { playlistId },
            _max: { sort: true },
        }),
    ]);
    const existingTrackIds = new Set(existingItems.map((item) => item.trackId));
    const additions = trackIds.filter(
        (trackId) => !existingTrackIds.has(trackId),
    );
    if (additions.length === 0) return false;
    const startSort = (maximum._max.sort ?? -1) + 1;
    await tx.playlistItem.createMany({
        data: additions.map((trackId, index) => ({
            playlistId,
            trackId,
            sort: startSort + index,
        })),
        skipDuplicates: true,
    });
    return true;
}

async function reindexLockedPlaylistItems(
    tx: Prisma.TransactionClient,
    playlistId: string,
): Promise<void> {
    // One set-based statement over the complete item set: a partial
    // (capped) reindex could leave sort gaps on oversized playlists.
    await tx.$executeRaw`
        WITH ranked AS (
            SELECT
                item.id,
                (ROW_NUMBER() OVER (
                    ORDER BY item.sort ASC, item.id ASC
                ) - 1)::integer AS "nextSort"
            FROM "PlaylistItem" item
            WHERE item."playlistId" = ${playlistId}
        )
        UPDATE "PlaylistItem" item
        SET sort = ranked."nextSort"
        FROM ranked
        WHERE item.id = ranked.id
    `;
}

async function updateLockedPlaylist(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    name: string,
    rawIndexes: string[],
    rawSongIdsToAdd: string[],
): Promise<PlaylistMutationResult> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    let trackIdsToAdd: string[];
    try {
        trackIdsToAdd = parseTrackIdsFromQueryValues(rawSongIdsToAdd);
    } catch {
        return "trackNotFound";
    }
    if (!(await ensureLibraryTracksExist(trackIdsToAdd, tx))) {
        return "trackNotFound";
    }
    if (name) {
        await tx.playlist.update({
            where: { id: playlistId },
            data: { name },
        });
    }
    const removedItems = await removeLockedPlaylistIndexes(
        tx,
        playlistId,
        rawIndexes,
    );
    const appendedItems = await appendLockedPlaylistTracks(
        tx,
        playlistId,
        trackIdsToAdd,
    );
    if (removedItems || appendedItems) {
        await reindexLockedPlaylistItems(tx, playlistId);
    }
    return "ok";
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
        const result = await prisma.$transaction(
            (tx) =>
                updateLockedPlaylist(
                    tx,
                    playlistId,
                    req.user!.id,
                    rawName,
                    rawSongIndexesToRemove,
                    rawSongIdsToAdd,
                ),
            {
                maxWait: PLAYLIST_TRANSACTION_MAX_WAIT_MS,
                timeout: PLAYLIST_TRANSACTION_TIMEOUT_MS,
            },
        );
        if (result === "trackNotFound") {
            sendPlaylistTrackNotFound(res, format, callback);
            return;
        }
        sendSubsonicSuccess(res, {}, format, callback);
    } catch (error) {
        if (error instanceof PlaylistMutationLockNotFoundError) {
            sendPlaylistMutationNotAuthorized(res, format, callback);
            return;
        }
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
