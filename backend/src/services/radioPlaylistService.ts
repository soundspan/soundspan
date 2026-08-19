import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import {
    isLibraryRadioPlaylistType,
    selectLibraryRadioStationTracks,
    type LibraryRadioPlaylistType,
    type LibraryRadioStationTrack,
} from "./libraryRadioStationSelection";
import { RADIO_PLAYLIST_MIX_ID_PREFIX } from "./radioPlaylistIdentity";

export const RADIO_PLAYLIST_DEFAULT_SIZE = 25;
export const RADIO_PLAYLIST_MAX_SIZE = 100;

export interface RadioPlaylistFilter {
    type: LibraryRadioPlaylistType;
    value?: string;
}

export interface RadioPlaylistResult {
    playlistId: string;
    entries: LibraryRadioStationTrack[];
}

export class RadioPlaylistServiceError extends Error {
    constructor(
        readonly statusCode: 400 | 403 | 404,
        message: string,
    ) {
        super(message);
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
    if (tracks.length === 0) return;
    await tx.playlistItem.createMany({
        data: toPlaylistItems(
            playlistId,
            tracks.map((track) => track.id),
        ),
        skipDuplicates: true,
    });
}

async function loadOwnedRadioPlaylist(playlistId: string, userId: string) {
    const playlist = await prisma.playlist.findUnique({
        where: { id: playlistId },
        select: { id: true, userId: true, mixId: true },
    });
    if (!playlist)
        throw new RadioPlaylistServiceError(404, "Playlist not found");
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

async function selectTracks(
    userId: string,
    filter: RadioPlaylistFilter,
    limit: number,
) {
    const selection = await selectLibraryRadioStationTracks({
        ...filter,
        limit,
        userId,
    });
    return uniqueTracks(selection.tracks).slice(0, limit);
}

/** Creates or replaces the user's generated playlist for one radio station. */
export async function createRadioPlaylist(
    userId: string,
    filterInput: RadioPlaylistFilter,
    size: number,
): Promise<RadioPlaylistResult> {
    const filter = normalizeFilter(filterInput);
    const tracks = await selectTracks(userId, filter, size);
    const playlist = await prisma.$transaction(async (tx) => {
        const saved = await tx.playlist.upsert({
            where: { userId_mixId: { userId, mixId: buildMixId(filter) } },
            create: {
                userId,
                mixId: buildMixId(filter),
                name: getPlaylistName(filter),
                isPublic: false,
            },
            update: { name: getPlaylistName(filter), updatedAt: new Date() },
            select: { id: true, name: true },
        });
        await replaceItems(tx, saved.id, tracks);
        return saved;
    });
    return { playlistId: playlist.id, entries: tracks };
}

/** Appends a bounded, deduplicated batch to an owned generated playlist. */
export async function appendRadioPlaylist(
    userId: string,
    playlistId: string,
    count: number,
): Promise<RadioPlaylistResult> {
    const { filter } = await loadOwnedRadioPlaylist(playlistId, userId);
    const currentItems = await prisma.playlistItem.findMany({
        where: { playlistId },
        select: { trackId: true, sort: true },
        orderBy: { sort: "asc" },
        take: RADIO_PLAYLIST_MAX_SIZE,
    });
    const remaining = Math.max(
        0,
        RADIO_PLAYLIST_MAX_SIZE - currentItems.length,
    );
    const appendCount = Math.min(count, remaining);
    if (appendCount === 0) return { playlistId, entries: [] };
    const candidateLimit = Math.min(
        RADIO_PLAYLIST_MAX_SIZE,
        currentItems.length + appendCount,
    );
    const candidates = await selectTracks(userId, filter, candidateLimit);
    const existingIds = new Set(currentItems.map((item) => item.trackId));
    const additions = candidates
        .filter((track) => !existingIds.has(track.id))
        .slice(0, appendCount);
    if (additions.length === 0) return { playlistId, entries: [] };
    const nextSort = currentItems.reduce(
        (highest, item) => Math.max(highest, item.sort + 1),
        0,
    );
    await prisma.$transaction(async (tx) => {
        await tx.playlistItem.createMany({
            data: toPlaylistItems(
                playlistId,
                additions.map((track) => track.id),
                nextSort,
            ),
            skipDuplicates: true,
        });
        await tx.playlist.update({
            where: { id: playlistId },
            data: { updatedAt: new Date() },
        });
    });
    return { playlistId, entries: additions };
}

/** Replaces all entries in an owned generated playlist using its stored filter. */
export async function regenerateRadioPlaylist(
    userId: string,
    playlistId: string,
): Promise<RadioPlaylistResult> {
    const { filter } = await loadOwnedRadioPlaylist(playlistId, userId);
    const currentItems = await prisma.playlistItem.findMany({
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
    const tracks = await selectTracks(userId, filter, size);
    await prisma.$transaction(async (tx) => {
        await replaceItems(tx, playlistId, tracks);
        await tx.playlist.update({
            where: { id: playlistId },
            data: { updatedAt: new Date() },
        });
    });
    return { playlistId, entries: tracks };
}
