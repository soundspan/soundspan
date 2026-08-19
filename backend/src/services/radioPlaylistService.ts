import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import {
    isLibraryRadioPlaylistType,
    selectLibraryRadioStationTracks,
    type LibraryRadioPlaylistType,
    type LibraryRadioStationTrack,
} from "./libraryRadioStationSelection";
import { takePlaylistLock } from "./playlistMutationLock";
import { RADIO_PLAYLIST_MIX_ID_PREFIX } from "./radioPlaylistIdentity";

export const RADIO_PLAYLIST_DEFAULT_SIZE = 25;
export const RADIO_PLAYLIST_MAX_SIZE = 100;
const PLAYLIST_LOCK_TIMEOUT_MS = 1_000;
const PLAYLIST_TRANSACTION_MAX_WAIT_MS = 2_000;
const PLAYLIST_TRANSACTION_TIMEOUT_MS = 15_000;
const PLAYLIST_TRANSACTION_ATTEMPTS = 3;

export interface RadioPlaylistFilter {
    type: LibraryRadioPlaylistType;
    value?: string;
}

export interface RadioPlaylistResult {
    playlistId: string;
    entries: LibraryRadioStationTrack[];
}

export const RADIO_PLAYLIST_RETRY_EXHAUSTED_CODE =
    "RADIO_PLAYLIST_RETRY_EXHAUSTED";

type RadioPlaylistServiceErrorCode = typeof RADIO_PLAYLIST_RETRY_EXHAUSTED_CODE;

export class RadioPlaylistServiceError extends Error {
    constructor(
        readonly statusCode: 400 | 403 | 404 | 503,
        message: string,
        readonly code?: RadioPlaylistServiceErrorCode,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "RadioPlaylistServiceError";
    }
}

function normalizeFilter(filter: RadioPlaylistFilter): RadioPlaylistFilter {
    const value = filter.value?.trim();
    return {
        type: filter.type,
        ...(value
            ? { value: filter.type === "genre" ? value.toLowerCase() : value }
            : {}),
    };
}

function buildMixId(filter: RadioPlaylistFilter): string {
    return `${RADIO_PLAYLIST_MIX_ID_PREFIX}${filter.type}:${filter.value ?? ""}`;
}

function parseMixId(mixId: string | null): RadioPlaylistFilter | null {
    if (!mixId?.startsWith(RADIO_PLAYLIST_MIX_ID_PREFIX)) return null;
    const stored = mixId.slice(RADIO_PLAYLIST_MIX_ID_PREFIX.length);
    const separatorIndex = stored.indexOf(":");
    if (separatorIndex < 0) return null;
    const type = stored.slice(0, separatorIndex);
    const value = stored.slice(separatorIndex + 1);
    if (!isLibraryRadioPlaylistType(type)) return null;
    return { type, ...(value ? { value } : {}) };
}

function getPlaylistName(filter: RadioPlaylistFilter): string {
    if (filter.type === "genre") {
        const genre = filter.value ?? "Genre";
        return `${genre.charAt(0).toUpperCase()}${genre.slice(1)} Radio`;
    }
    if (filter.type === "decade") {
        const decade = filter.value ?? "2000";
        return `${decade.startsWith("19") ? decade.slice(2) : decade}s Radio`;
    }
    const names: Record<
        Exclude<LibraryRadioPlaylistType, "genre" | "decade">,
        string
    > = {
        discovery: "Discovery Radio",
        favorites: "Favorites Radio",
        workout: "Workout Radio",
    };
    return names[filter.type];
}

function uniqueTracks(
    tracks: LibraryRadioStationTrack[],
): LibraryRadioStationTrack[] {
    const seen = new Set<string>();
    return tracks.filter((track) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
    });
}

function toPlaylistItems(playlistId: string, trackIds: string[], start = 0) {
    return trackIds.map((trackId, index) => ({
        playlistId,
        trackId,
        sort: start + index,
    }));
}

async function replaceItems(
    tx: Prisma.TransactionClient,
    playlistId: string,
    tracks: LibraryRadioStationTrack[],
) {
    await tx.playlistItem.deleteMany({ where: { playlistId } });
    if (tracks.length === 0) return 0;
    const created = await tx.playlistItem.createMany({
        data: toPlaylistItems(
            playlistId,
            tracks.map((track) => track.id),
        ),
        skipDuplicates: true,
    });
    return created.count;
}

async function lockOwnedRadioPlaylist(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
) {
    const lockConfiguration = await tx.$queryRaw<{ lockTimeout: string }[]>`
        SELECT set_config(
            'lock_timeout',
            ${`${PLAYLIST_LOCK_TIMEOUT_MS}ms`},
            true
        ) AS "lockTimeout"
    `;
    if (lockConfiguration.length !== 1) {
        throw new Error("Failed to configure playlist lock timeout");
    }
    const playlist = await takePlaylistLock(tx, playlistId, userId);
    if (!playlist) {
        const existing = await tx.playlist.findUnique({
            where: { id: playlistId },
            select: { userId: true },
        });
        if (existing) {
            throw new RadioPlaylistServiceError(403, "Access denied");
        }
        throw new RadioPlaylistServiceError(404, "Playlist not found");
    }
    if (playlist.userId !== userId) {
        throw new RadioPlaylistServiceError(403, "Access denied");
    }
    const filter = parseMixId(playlist.mixId);
    if (!filter) {
        throw new RadioPlaylistServiceError(
            400,
            "Playlist is not a generated radio playlist",
        );
    }
    return { playlist, filter };
}

function isRetryableTransactionError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const message =
        typeof record.message === "string" ? record.message.toLowerCase() : "";
    return (
        ["55P03", "40001", "40P01", "P2034"].includes(code) ||
        message.includes("lock timeout") ||
        message.includes("could not serialize") ||
        message.includes("deadlock detected")
    );
}

function isUniqueConstraintError(error: unknown): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2002",
    );
}

async function pauseBeforeRetry(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 25));
}

async function withLockedPlaylistTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    for (
        let attempt = 0;
        attempt < PLAYLIST_TRANSACTION_ATTEMPTS;
        attempt += 1
    ) {
        try {
            return await prisma.$transaction(operation, {
                maxWait: PLAYLIST_TRANSACTION_MAX_WAIT_MS,
                timeout: PLAYLIST_TRANSACTION_TIMEOUT_MS,
            });
        } catch (error) {
            if (!isRetryableTransactionError(error)) throw error;
            if (attempt + 1 >= PLAYLIST_TRANSACTION_ATTEMPTS) {
                throw new RadioPlaylistServiceError(
                    503,
                    "Radio playlist is temporarily unavailable",
                    RADIO_PLAYLIST_RETRY_EXHAUSTED_CODE,
                    { cause: error },
                );
            }
            await pauseBeforeRetry(attempt);
        }
    }
    throw new RadioPlaylistServiceError(
        503,
        "Radio playlist is temporarily unavailable",
        RADIO_PLAYLIST_RETRY_EXHAUSTED_CODE,
    );
}

async function selectTracks(
    userId: string,
    filter: RadioPlaylistFilter,
    limit: number,
    client: Prisma.TransactionClient | typeof prisma = prisma,
) {
    const selection = await selectLibraryRadioStationTracks(
        { ...filter, limit, userId },
        client,
    );
    return uniqueTracks(selection.tracks).slice(0, limit);
}

async function loadExistingRadioPlaylist(
    userId: string,
    mixId: string,
): Promise<RadioPlaylistResult | null> {
    const playlist = await prisma.playlist.findUnique({
        where: { userId_mixId: { userId, mixId } },
        select: {
            id: true,
            items: {
                select: { trackId: true },
                orderBy: { sort: "asc" },
                take: RADIO_PLAYLIST_MAX_SIZE,
            },
        },
    });
    if (!playlist) return null;
    const entries = playlist.items.flatMap((item) =>
        item.trackId ? [{ id: item.trackId }] : [],
    );
    return { playlistId: playlist.id, entries };
}

/** Creates a station playlist when absent, otherwise returns it unchanged. */
export async function createRadioPlaylist(
    userId: string,
    filterInput: RadioPlaylistFilter,
    size: number,
): Promise<RadioPlaylistResult> {
    const filter = normalizeFilter(filterInput);
    const mixId = buildMixId(filter);
    const existing = await loadExistingRadioPlaylist(userId, mixId);
    if (existing) return existing;
    const tracks = await selectTracks(userId, filter, size);
    try {
        return await prisma.$transaction(async (tx) => {
            const playlist = await tx.playlist.create({
                data: {
                    userId,
                    mixId,
                    name: getPlaylistName(filter),
                    isPublic: false,
                },
                select: { id: true },
            });
            const createdCount = await replaceItems(tx, playlist.id, tracks);
            return {
                playlistId: playlist.id,
                entries: tracks.slice(0, createdCount),
            };
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const racedPlaylist = await loadExistingRadioPlaylist(userId, mixId);
        if (racedPlaylist) return racedPlaylist;
        throw error;
    }
}

async function appendLocked(
    tx: Prisma.TransactionClient,
    userId: string,
    playlistId: string,
    count: number,
): Promise<RadioPlaylistResult> {
    const { filter } = await lockOwnedRadioPlaylist(tx, playlistId, userId);
    const currentItems = await tx.playlistItem.findMany({
        where: { playlistId },
        select: { trackId: true, sort: true },
        orderBy: { sort: "asc" },
        take: RADIO_PLAYLIST_MAX_SIZE,
    });
    const appendCount = Math.min(
        count,
        Math.max(0, RADIO_PLAYLIST_MAX_SIZE - currentItems.length),
    );
    if (appendCount === 0) return { playlistId, entries: [] };
    const candidateLimit = Math.min(
        RADIO_PLAYLIST_MAX_SIZE,
        currentItems.length + appendCount,
    );
    const candidates = await selectTracks(userId, filter, candidateLimit, tx);
    const existingIds = new Set(currentItems.map((item) => item.trackId));
    const additions = candidates
        .filter((track) => !existingIds.has(track.id))
        .slice(0, appendCount);
    if (additions.length === 0) return { playlistId, entries: [] };
    const nextSort = currentItems.reduce(
        (highest, item) => Math.max(highest, item.sort + 1),
        0,
    );
    const created = await tx.playlistItem.createMany({
        data: toPlaylistItems(
            playlistId,
            additions.map((track) => track.id),
            nextSort,
        ),
        skipDuplicates: true,
    });
    if (created.count > 0) {
        await tx.playlist.update({
            where: { id: playlistId },
            data: { updatedAt: new Date() },
        });
    }
    return { playlistId, entries: additions.slice(0, created.count) };
}

/** Appends a bounded, deduplicated batch to an owned generated playlist. */
export async function appendRadioPlaylist(
    userId: string,
    playlistId: string,
    count: number,
): Promise<RadioPlaylistResult> {
    return withLockedPlaylistTransaction((tx) =>
        appendLocked(tx, userId, playlistId, count),
    );
}

async function regenerateLocked(
    tx: Prisma.TransactionClient,
    userId: string,
    playlistId: string,
): Promise<RadioPlaylistResult> {
    const { filter } = await lockOwnedRadioPlaylist(tx, playlistId, userId);
    const currentItems = await tx.playlistItem.findMany({
        where: { playlistId },
        select: { trackId: true, sort: true },
        orderBy: { sort: "asc" },
        take: RADIO_PLAYLIST_MAX_SIZE,
    });
    const size = Math.max(
        1,
        Math.min(
            currentItems.length || RADIO_PLAYLIST_DEFAULT_SIZE,
            RADIO_PLAYLIST_MAX_SIZE,
        ),
    );
    const tracks = await selectTracks(userId, filter, size, tx);
    const createdCount = await replaceItems(tx, playlistId, tracks);
    await tx.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
    });
    return { playlistId, entries: tracks.slice(0, createdCount) };
}

/** Replaces all entries in an owned generated playlist using its stored filter. */
export async function regenerateRadioPlaylist(
    userId: string,
    playlistId: string,
): Promise<RadioPlaylistResult> {
    return withLockedPlaylistTransaction((tx) =>
        regenerateLocked(tx, userId, playlistId),
    );
}
