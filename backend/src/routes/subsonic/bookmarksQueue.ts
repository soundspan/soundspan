import { type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { parseSubsonicId, toSubsonicId } from "../../utils/subsonicIds";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
    type ResponseFormat,
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
    loadSongEnrichmentByTrackId,
    parseBookmarkPositionOrError,
    parseEntityIdOrNotFound,
    parseTrackIdsPreserveOrder,
    SONG_LOUDNESS_ALBUM_SELECT,
    SONG_LOUDNESS_TRACK_SELECT,
    SUBSONIC_ALBUM_LOCATION_WHERE,
} from "./shared";

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

function sendQueueError(
    res: Response,
    code: SubsonicErrorCode,
    message: string,
    format: ResponseFormat,
    callback?: string,
): void {
    sendSubsonicError(res, code, message, format, callback);
}

type PlayQueueState = {
    currentIndex: number;
    currentTime: number;
    updatedAt: Date;
};

type FormattedPlayQueue = {
    entry: Record<string, unknown>[];
    sourceIndexes: number[];
};

const PLAY_QUEUE_CHANGED_BY = "soundspan";
type PlayQueueResponseKey = "playQueue" | "playQueueByIndex";

function buildEmptyPlayQueueResponse(
    responseKey: PlayQueueResponseKey,
    username: string,
): Record<string, unknown> {
    return {
        [responseKey]: {
            position: 0,
            username,
            changed: new Date().toISOString(),
            changedBy: PLAY_QUEUE_CHANGED_BY,
            entry: [],
        },
    };
}

function findSurvivingCurrentIndex(
    state: PlayQueueState,
    queueTrackIds: string[],
    formatted: FormattedPlayQueue,
): number {
    if (!queueTrackIds[state.currentIndex]) return -1;
    return formatted.sourceIndexes.indexOf(state.currentIndex);
}

function buildSharedQueueFields(
    state: PlayQueueState,
    formatted: FormattedPlayQueue,
    username: string,
    currentSurvived: boolean,
): Record<string, unknown> {
    return {
        position: currentSurvived
            ? Math.max(0, Math.round(state.currentTime * 1000))
            : 0,
        username,
        changed: state.updatedAt.toISOString(),
        changedBy: PLAY_QUEUE_CHANGED_BY,
        entry: formatted.entry,
    };
}

function buildClassicPlayQueueResponse(
    state: PlayQueueState,
    queueTrackIds: string[],
    formatted: FormattedPlayQueue,
    username: string,
): Record<string, unknown> {
    const currentIndex = findSurvivingCurrentIndex(
        state,
        queueTrackIds,
        formatted,
    );
    const current = formatted.entry[currentIndex]?.id;
    return {
        playQueue: {
            ...(typeof current === "string" ? { current } : {}),
            ...buildSharedQueueFields(
                state,
                formatted,
                username,
                currentIndex >= 0,
            ),
        },
    };
}

function buildIndexPlayQueueResponse(
    state: PlayQueueState,
    queueTrackIds: string[],
    formatted: FormattedPlayQueue,
    username: string,
): Record<string, unknown> {
    const survivingCurrent = findSurvivingCurrentIndex(
        state,
        queueTrackIds,
        formatted,
    );
    const nextIndex = formatted.sourceIndexes.findIndex(
        (sourceIndex) => sourceIndex > state.currentIndex,
    );
    const currentIndex =
        survivingCurrent >= 0 ? survivingCurrent : Math.max(0, nextIndex);
    return {
        playQueueByIndex: {
            ...(formatted.entry.length > 0 ? { currentIndex } : {}),
            ...buildSharedQueueFields(
                state,
                formatted,
                username,
                survivingCurrent >= 0,
            ),
        },
    };
}

function parseSubmittedQueueTrackIds(
    req: Request,
    res: Response,
    format: ResponseFormat,
    callback?: string,
): string[] | null {
    try {
        return parseTrackIdsPreserveOrder(getQueryValues(req.query.id));
    } catch {
        sendQueueError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Song not found",
            format,
            callback,
        );
        return null;
    }
}

function resolveClassicCurrentIndex(
    value: unknown,
    trackIds: string[],
): number {
    if (typeof value !== "string") return 0;
    try {
        const requestedTrackId = parseSubsonicId(value, "track").id;
        const matchingIndex = trackIds.indexOf(requestedTrackId);
        if (matchingIndex >= 0) return matchingIndex;
    } catch {
        // Fall through to the legacy integer interpretation.
    }
    if (!/^\d+$/.test(value)) return 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed < trackIds.length
        ? parsed
        : 0;
}

const playQueueTrackSelect = Prisma.validator<Prisma.TrackSelect>()({
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
            artist: { select: { id: true, name: true } },
        },
    },
});

type PlayQueueTrack = Prisma.TrackGetPayload<{
    select: typeof playQueueTrackSelect;
}>;

function parseQueueTrackIds(queue: unknown): string[] {
    if (!Array.isArray(queue)) return [];
    return queue.flatMap((item) => {
        if (
            typeof item !== "object" ||
            item === null ||
            !("id" in item) ||
            typeof (item as { id?: unknown }).id !== "string"
        ) {
            return [];
        }
        const id = (item as { id: string }).id;
        try {
            return [parseSubsonicId(id, "track").id];
        } catch {
            return [id];
        }
    });
}

async function loadPlayQueueTracks(
    trackIds: string[],
): Promise<PlayQueueTrack[]> {
    const uniqueTrackIds = Array.from(new Set(trackIds));
    if (uniqueTrackIds.length === 0) return [];
    return prisma.track.findMany({
        where: {
            ...LIBRARY_TRACK_WHERE,
            id: { in: uniqueTrackIds },
            album: { location: SUBSONIC_ALBUM_LOCATION_WHERE },
        },
        select: playQueueTrackSelect,
    });
}

async function formatPlayQueueEntries(
    userId: string,
    queueTrackIds: string[],
    tracks: PlayQueueTrack[],
): Promise<FormattedPlayQueue> {
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const playedAtByTrackId = await loadSongEnrichmentByTrackId(
        userId,
        tracks.map((track) => track.id),
    );
    const formatted = queueTrackIds.flatMap((trackId, sourceIndex) => {
        const track = trackById.get(trackId);
        return track
            ? [
                  {
                      value: formatSongForSubsonic(
                          track,
                          playedAtByTrackId.get(track.id),
                      ),
                      sourceIndex,
                  },
              ]
            : [];
    });
    return {
        entry: formatted.map(({ value }) => value),
        sourceIndexes: formatted.map(({ sourceIndex }) => sourceIndex),
    };
}

async function loadPlayQueue(req: Request): Promise<{
    state: PlayQueueState | null;
    queueTrackIds: string[];
    formatted: FormattedPlayQueue;
}> {
    const deviceId = getLegacyPlaybackDeviceId(
        parsePlaybackDeviceIndex(req.query.index),
    );
    const state = await prisma.playbackState.findUnique({
        where: {
            userId_deviceId: {
                userId: req.user!.id,
                deviceId,
            },
        },
    });
    const queueTrackIds = parseQueueTrackIds(state?.queue);
    const tracks = await loadPlayQueueTracks(queueTrackIds);
    const formatted = await formatPlayQueueEntries(
        req.user!.id,
        queueTrackIds,
        tracks,
    );
    return { state, queueTrackIds, formatted };
}

async function sendLoadedPlayQueue(
    req: Request,
    res: Response,
    responseKey: PlayQueueResponseKey,
    buildResponse: (
        state: PlayQueueState,
        queueTrackIds: string[],
        formatted: FormattedPlayQueue,
        username: string,
    ) => Record<string, unknown>,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    try {
        const { state, queueTrackIds, formatted } = await loadPlayQueue(req);
        if (!state) {
            sendSubsonicSuccess(
                res,
                buildEmptyPlayQueueResponse(responseKey, req.user!.username),
                format,
                callback,
            );
            return;
        }
        sendSubsonicSuccess(
            res,
            buildResponse(state, queueTrackIds, formatted, req.user!.username),
            format,
            callback,
        );
    } catch {
        sendQueueError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch play queue",
            format,
            callback,
        );
    }
}

/** Executes the classic ID-based getPlayQueue endpoint. */
export async function handleGetPlayQueue(
    req: Request,
    res: Response,
): Promise<void> {
    await sendLoadedPlayQueue(
        req,
        res,
        "playQueue",
        buildClassicPlayQueueResponse,
    );
}

const savedQueueTrackSelect = Prisma.validator<Prisma.TrackSelect>()({
    id: true,
    title: true,
    duration: true,
    album: {
        select: {
            id: true,
            title: true,
            coverUrl: true,
            artist: { select: { id: true, name: true } },
        },
    },
});

type SavedQueueTrack = Prisma.TrackGetPayload<{
    select: typeof savedQueueTrackSelect;
}>;

type SavedQueueEntry = {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
};

function formatSavedQueue(
    trackIds: string[],
    tracks: SavedQueueTrack[],
): SavedQueueEntry[] {
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    return trackIds.flatMap((trackId) => {
        const track = trackById.get(trackId);
        if (!track) return [];
        return [
            {
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
            },
        ];
    });
}

async function buildSavedQueue(trackIds: string[]): Promise<{
    valid: boolean;
    queue: SavedQueueEntry[];
}> {
    const uniqueTrackIds = Array.from(new Set(trackIds));
    if (!(await ensureLibraryTracksExist(uniqueTrackIds))) {
        return { valid: false, queue: [] };
    }
    const tracks = uniqueTrackIds.length
        ? await prisma.track.findMany({
              where: {
                  ...LIBRARY_TRACK_WHERE,
                  id: { in: uniqueTrackIds },
                  album: { location: SUBSONIC_ALBUM_LOCATION_WHERE },
              },
              select: savedQueueTrackSelect,
          })
        : [];
    return { valid: true, queue: formatSavedQueue(trackIds, tracks) };
}

async function persistSavedQueue(input: {
    userId: string;
    deviceId: string;
    queue: SavedQueueEntry[];
    currentIndex: number;
    positionMs: number;
}): Promise<void> {
    const currentTrackId = input.queue.length
        ? parseSubsonicId(input.queue[input.currentIndex].id, "track").id
        : null;
    const state = {
        playbackType: "track" as const,
        trackId: currentTrackId,
        queue: input.queue.length ? input.queue : Prisma.DbNull,
        currentIndex: input.currentIndex,
        currentTime: input.positionMs / 1000,
        isShuffle: false,
    };
    await prisma.playbackState.upsert({
        where: {
            userId_deviceId: { userId: input.userId, deviceId: input.deviceId },
        },
        update: state,
        create: { userId: input.userId, deviceId: input.deviceId, ...state },
    });
}

function parseIndexBasedCurrent(
    value: unknown,
    trackCount: number,
): number | null {
    if (trackCount === 0) return value === undefined ? 0 : null;
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed < trackCount ? parsed : null;
}

async function saveSubmittedPlayQueue(
    req: Request,
    res: Response,
    trackIds: string[],
    currentIndex: number,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const deviceId = getLegacyPlaybackDeviceId(
        parsePlaybackDeviceIndex(req.query.index),
    );
    try {
        const savedQueue = await buildSavedQueue(trackIds);
        if (!savedQueue.valid) {
            sendQueueError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }
        await persistSavedQueue({
            userId: req.user!.id,
            deviceId,
            queue: savedQueue.queue,
            currentIndex,
            positionMs: parseQueuePositionMs(req.query.position),
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendQueueError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to save play queue",
            format,
            callback,
        );
    }
}

/** Executes the classic ID-based savePlayQueue endpoint. */
export async function handleSavePlayQueue(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const trackIds = parseSubmittedQueueTrackIds(req, res, format, callback);
    if (!trackIds) return;
    const currentIndex = resolveClassicCurrentIndex(
        req.query.current,
        trackIds,
    );
    await saveSubmittedPlayQueue(req, res, trackIds, currentIndex);
}

/**
 * Executes handleGetPlayQueueByIndex.
 */
export async function handleGetPlayQueueByIndex(
    req: Request,
    res: Response,
): Promise<void> {
    await sendLoadedPlayQueue(
        req,
        res,
        "playQueueByIndex",
        buildIndexPlayQueueResponse,
    );
}

/**
 * Executes handleSavePlayQueueByIndex.
 */
export async function handleSavePlayQueueByIndex(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const trackIds = parseSubmittedQueueTrackIds(req, res, format, callback);
    if (!trackIds) return;
    const currentIndex = parseIndexBasedCurrent(
        req.query.currentIndex,
        trackIds.length,
    );
    if (currentIndex === null) {
        sendQueueError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'currentIndex' is missing or invalid",
            format,
            callback,
        );
        return;
    }
    await saveSubmittedPlayQueue(req, res, trackIds, currentIndex);
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
        const playedAtByTrackId = await loadSongEnrichmentByTrackId(
            req.user!.id,
            bookmarks.map((bookmark) => bookmark.track.id),
        );

        sendSubsonicSuccess(
            res,
            {
                bookmarks: {
                    bookmark: bookmarks.map((bookmark) =>
                        formatBookmarkForSubsonic(
                            bookmark,
                            req.user!.username,
                            playedAtByTrackId.get(bookmark.track.id),
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
