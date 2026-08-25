import path from "path";
import { type Request, type Response } from "express";
import { Prisma, type AlbumLocation } from "@prisma/client";
import { prisma } from "../../utils/db";
import {
    getResponseFormat,
    sendSubsonicError,
    SubsonicErrorCode,
    type ResponseFormat,
} from "../../utils/subsonicResponse";
import {
    parseSubsonicId,
    SubsonicIdError,
    toSubsonicId,
    type SubsonicEntityType,
} from "../../utils/subsonicIds";
import { config } from "../../config";
import { safeResolvePath } from "../../utils/safeResolvePath";
import { fetchExternalImage } from "../../services/imageProxy";
import {
    isLibrarySurfaceAlbumLocation,
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";
import {
    combineSongEnrichmentForAlbum,
    loadSongEnrichmentByTrackId,
    type SongEnrichment,
} from "./songEnrichment";

const LIBRARY_LOCATION = "LIBRARY";
const SUBSONIC_ALBUM_LOCATION_WHERE: Prisma.EnumAlbumLocationFilter = {
    in: [LIBRARY_LOCATION, "FEDERATED"],
};
const LIBRARY_TRACK_WHERE = {
    ...TRACK_VISIBLE_WHERE,
    ...TRACK_BROWSE_WHERE,
    album: { location: SUBSONIC_ALBUM_LOCATION_WHERE },
} satisfies Prisma.TrackWhereInput;
const PLAYLIST_TRACK_WHERE = {
    ...TRACK_VISIBLE_WHERE,
    ...TRACK_BROWSE_WHERE,
} satisfies Prisma.TrackWhereInput;

const SONG_LOUDNESS_TRACK_SELECT = {
    loudnessLufs: true,
    truePeakDb: true,
} as const;
const SONG_LOUDNESS_ALBUM_SELECT = {
    albumLoudnessLufs: true,
    albumTruePeakDb: true,
} as const;

const LIBRARY_ALBUM_WHERE = {
    location: SUBSONIC_ALBUM_LOCATION_WHERE,
    tracks: { some: LIBRARY_TRACK_WHERE },
} satisfies Prisma.AlbumWhereInput;
const SUBSONIC_COVER_CACHE_CONTROL = "public, max-age=86400";
const DEFAULT_SUBSONIC_AVATAR_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6fQAAAAASUVORK5CYII=",
    "base64",
);

const AUDIO_MIME_BY_SUFFIX: Record<string, string> = {
    mp3: "audio/mpeg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    aac: "audio/aac",
};

function getCallback(req: Request): string | undefined {
    return typeof req.query.callback === "string"
        ? req.query.callback
        : undefined;
}

function getRequestContext(req: Request): {
    format: ResponseFormat;
    callback?: string;
} {
    return {
        format: getResponseFormat(req.query),
        callback: getCallback(req),
    };
}

function parseCountParam(value: unknown, fallback: number, max = 200): number {
    if (typeof value !== "string") {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }

    return Math.max(0, Math.min(parsed, max));
}

function parseSearchCountParam(
    value: unknown,
    fallback: number,
    max: number,
): number {
    if (typeof value !== "string") {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }

    if (parsed === 0) {
        return max;
    }

    if (parsed < 0) {
        return 0;
    }

    return Math.min(parsed, max);
}

function parseOffsetParam(value: unknown): number {
    if (typeof value !== "string") {
        return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return 0;
    }

    return Math.max(0, parsed);
}

function parseTimestampParam(value: unknown): number | null {
    if (typeof value !== "string") {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return null;
    }

    return Math.max(0, parsed);
}

const ALBUM_LIST_TYPES = [
    "random",
    "newest",
    "highest",
    "frequent",
    "recent",
    "alphabeticalByName",
    "alphabeticalByArtist",
    "starred",
    "byYear",
    "byGenre",
] as const;

type AlbumListType = (typeof ALBUM_LIST_TYPES)[number];

const ALBUM_LIST_TYPE_SET = new Set<string>(ALBUM_LIST_TYPES);

const SUBSONIC_MUSIC_FOLDER_ID = "1";
const SEARCH_ARTIST_MAX_COUNT = 5000;
const SEARCH_ALBUM_MAX_COUNT = 5000;
const SEARCH_SONG_MAX_COUNT = 50000;

function parseMusicFolderId(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function isUnsupportedMusicFolderId(value: unknown): boolean {
    const musicFolderId = parseMusicFolderId(value);
    return (
        musicFolderId.length > 0 && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID
    );
}

function normalizeSearchQuery(rawQuery: string): string {
    const trimmed = rawQuery.trim();
    if (trimmed.length >= 2) {
        const firstChar = trimmed.charAt(0);
        const lastChar = trimmed.charAt(trimmed.length - 1);
        if (
            (firstChar === `"` || firstChar === "'") &&
            firstChar === lastChar
        ) {
            return trimmed.slice(1, -1).trim();
        }
    }

    return trimmed;
}

const albumListSelect = Prisma.validator<Prisma.AlbumSelect>()({
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
});

type AlbumListRecord = Prisma.AlbumGetPayload<{
    select: typeof albumListSelect;
}>;

function parseAlbumListType(value: unknown): AlbumListType | null {
    if (typeof value !== "string") {
        return null;
    }

    return ALBUM_LIST_TYPE_SET.has(value) ? (value as AlbumListType) : null;
}

function parseYearParam(value: unknown): number | null {
    if (typeof value !== "string") {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return null;
    }

    return parsed;
}

function mapAlbumsForSubsonic(
    albums: AlbumListRecord[],
    enrichmentByTrackId: ReadonlyMap<string, SongEnrichment> = new Map(),
    enrichmentByAlbumId: ReadonlyMap<string, SongEnrichment> = new Map(),
): Record<string, unknown>[] {
    return albums.map((album) =>
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
                songCount: album.tracks.length,
                duration: album.tracks.reduce(
                    (sum, track) => sum + (track.duration ?? 0),
                    0,
                ),
            },
            enrichmentByAlbumId.get(album.id) ??
                combineSongEnrichmentForAlbum(
                    album.tracks.map((track) => track.id),
                    enrichmentByTrackId,
                ),
        ),
    );
}

function shuffleInPlace<T>(values: T[]): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
    }
}

type AlbumPlayStat = {
    playCount: number;
    lastPlayed: Date | null;
};

type AlbumPlayStats = {
    byAlbumId: Map<string, AlbumPlayStat>;
    byTrackId: Map<string, SongEnrichment>;
};

async function loadGroupedTrackPlays(userId: string) {
    return prisma.play.groupBy({
        by: ["trackId"],
        where: {
            userId,
            track: {
                ...LIBRARY_TRACK_WHERE,
                album: { location: SUBSONIC_ALBUM_LOCATION_WHERE },
            },
        },
        _count: { _all: true },
        _max: { playedAt: true },
    });
}

type GroupedTrackPlay = Awaited<
    ReturnType<typeof loadGroupedTrackPlays>
>[number];

async function loadAlbumIdsForGroupedPlays(
    groupedPlays: GroupedTrackPlay[],
): Promise<Map<string, string>> {
    const trackIds = groupedPlays.flatMap((entry) =>
        entry.trackId ? [entry.trackId] : [],
    );
    if (trackIds.length === 0) return new Map();
    const tracks = await prisma.track.findMany({
        where: {
            ...LIBRARY_TRACK_WHERE,
            id: { in: trackIds },
            album: { location: SUBSONIC_ALBUM_LOCATION_WHERE },
        },
        select: { id: true, albumId: true },
    });
    return new Map(tracks.map((track) => [track.id, track.albumId]));
}

function aggregateAlbumPlayStats(
    groupedPlays: GroupedTrackPlay[],
    albumIdByTrackId: ReadonlyMap<string, string>,
): AlbumPlayStats {
    const byAlbumId = new Map<string, AlbumPlayStat>();
    const byTrackId = new Map<string, SongEnrichment>();
    for (const entry of groupedPlays) {
        if (!entry.trackId) continue;
        const albumId = albumIdByTrackId.get(entry.trackId);
        if (!albumId) continue;
        const playCount = entry._count._all;
        const lastPlayed = entry._max.playedAt ?? null;
        byTrackId.set(entry.trackId, {
            playedAt: lastPlayed ?? undefined,
            playCount: playCount || undefined,
        });
        const current = byAlbumId.get(albumId);
        byAlbumId.set(albumId, {
            playCount: (current?.playCount ?? 0) + playCount,
            lastPlayed:
                lastPlayed &&
                (!current?.lastPlayed || lastPlayed > current.lastPlayed)
                    ? lastPlayed
                    : (current?.lastPlayed ?? null),
        });
    }
    return { byAlbumId, byTrackId };
}

async function buildAlbumPlayStats(userId: string): Promise<AlbumPlayStats> {
    const groupedPlays = await loadGroupedTrackPlays(userId);
    const albumIdByTrackId = await loadAlbumIdsForGroupedPlays(groupedPlays);
    return aggregateAlbumPlayStats(groupedPlays, albumIdByTrackId);
}

function getQueryValues(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter(
            (entry): entry is string => typeof entry === "string",
        );
    }

    if (typeof value === "string") {
        return [value];
    }

    return [];
}

function getRequiredQueryString(
    req: Request,
    res: Response,
    key: string,
    format: ResponseFormat,
    callback?: string,
): string | null {
    const value = req.query[key];
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }

    sendSubsonicError(
        res,
        SubsonicErrorCode.MISSING_PARAMETER,
        `Required parameter '${key}' is missing`,
        format,
        callback,
    );
    return null;
}

function getRequiredQueryValue(
    req: Request,
    res: Response,
    key: string,
    format: ResponseFormat,
    callback?: string,
): string | null {
    const value = req.query[key];
    if (typeof value === "string") {
        return value;
    }

    sendSubsonicError(
        res,
        SubsonicErrorCode.MISSING_PARAMETER,
        `Required parameter '${key}' is missing`,
        format,
        callback,
    );
    return null;
}

function parseEntityId(
    rawId: string,
    expectedType: SubsonicEntityType,
): string {
    return parseSubsonicId(rawId, expectedType).id;
}

function parseEntityIdOrNotFound(
    req: Request,
    res: Response,
    rawId: string,
    expectedType: SubsonicEntityType,
    notFoundMessage: string,
    format: ResponseFormat,
    callback?: string,
): string | null {
    try {
        return parseEntityId(rawId, expectedType);
    } catch (error) {
        const message =
            error instanceof SubsonicIdError ? notFoundMessage : "Invalid ID";
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            message,
            format,
            callback,
        );
        return null;
    }
}

function parseBookmarkPositionOrError(
    req: Request,
    res: Response,
    format: ResponseFormat,
    callback?: string,
): number | null {
    const rawPosition = getRequiredQueryString(
        req,
        res,
        "position",
        format,
        callback,
    );
    if (!rawPosition) {
        return null;
    }

    const positionMs = Number.parseInt(rawPosition, 10);
    if (Number.isNaN(positionMs) || positionMs < 0) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Invalid bookmark position",
            format,
            callback,
        );
        return null;
    }

    return positionMs / 1000;
}

function getFileSuffix(filePath: string): string | undefined {
    const extension = path.extname(filePath).toLowerCase();
    if (!extension.startsWith(".")) {
        return undefined;
    }

    const suffix = extension.slice(1);
    return suffix.length > 0 ? suffix : undefined;
}

function getContentType(mime: string | null, suffix?: string): string {
    if (mime && mime.length > 0) {
        return mime;
    }

    if (suffix && AUDIO_MIME_BY_SUFFIX[suffix]) {
        return AUDIO_MIME_BY_SUFFIX[suffix];
    }

    return "audio/mpeg";
}

function parseSyncedLyricsLines(
    syncedLyrics: string,
): Array<{ value: string; start: number }> {
    const lines: Array<{ value: string; start: number }> = [];

    for (const rawLine of syncedLyrics.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const match = line.match(/^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)$/);
        if (!match) {
            continue;
        }

        const minutes = Number.parseInt(match[1], 10);
        const seconds = Number.parseInt(match[2], 10);
        const fraction = Number.parseInt(match[3], 10);
        const text = match[4] ?? "";

        const fractionMs = match[3].length === 2 ? fraction * 10 : fraction;
        const startMs = minutes * 60 * 1000 + seconds * 1000 + fractionMs;

        lines.push({
            value: text,
            start: startMs,
        });
    }

    return lines;
}

async function fetchCoverArtBuffer(
    url: string,
): Promise<{ buffer: Buffer; contentType: string }> {
    const result = await fetchExternalImage({
        url,
        timeoutMs: 10_000,
        maxRetries: 1,
    });

    if (!result.ok) {
        if (result.status === "not_found" || result.status === "invalid_url") {
            throw new Error("COVER_FETCH_FAILED:404");
        }
        throw new Error("COVER_FETCH_FAILED");
    }

    return {
        buffer: result.buffer,
        contentType: result.contentType ?? "image/jpeg",
    };
}

function resolveNativeCoverPath(nativeCoverPath: string): string | null {
    const coverRoot = path.resolve(
        path.join(config.music.transcodeCachePath, "../covers"),
    );
    return safeResolvePath(coverRoot, nativeCoverPath);
}

function extractFirstGenreValue(rawGenres: unknown): string | undefined {
    if (!Array.isArray(rawGenres)) {
        return undefined;
    }

    for (const entry of rawGenres) {
        if (typeof entry === "string") {
            const trimmed = entry.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }

    return undefined;
}

function extractGenreValues(rawGenres: unknown): string[] {
    if (!Array.isArray(rawGenres)) {
        return [];
    }

    const values: string[] = [];
    for (const entry of rawGenres) {
        if (typeof entry !== "string") {
            continue;
        }

        const trimmed = entry.trim();
        if (trimmed.length === 0) {
            continue;
        }

        values.push(trimmed);
    }

    return Array.from(new Set(values));
}

function formatArtistForSubsonic(artist: {
    id: string;
    name: string;
    albumCount: number;
    heroUrl: string | null;
}): Record<string, unknown> {
    const formatted: Record<string, unknown> = {
        id: toSubsonicId("artist", artist.id),
        name: artist.name,
        albumCount: artist.albumCount,
    };

    if (artist.heroUrl) {
        formatted.coverArt = toSubsonicId("artist", artist.id);
    }

    return formatted;
}

function formatAlbumForSubsonic(
    album: {
        id: string;
        title: string;
        year: number | null;
        lastSynced: Date;
        coverUrl: string | null;
        location: AlbumLocation;
        genres?: unknown;
        userGenres?: unknown;
        artist: {
            id: string;
            name: string;
        };
        songCount: number;
        duration: number;
    },
    enrichment: SongEnrichment = {},
): Record<string, unknown> {
    if (!isLibrarySurfaceAlbumLocation(album.location)) {
        throw new Error("Album location is not visible through Subsonic");
    }
    const formatted: Record<string, unknown> = {
        id: toSubsonicId("album", album.id),
        parent: toSubsonicId("artist", album.artist.id),
        isDir: true,
        title: album.title,
        name: album.title,
        album: album.title,
        artist: album.artist.name,
        artistId: toSubsonicId("artist", album.artist.id),
        songCount: album.songCount,
        duration: album.duration,
        // Consistent with getAlbumList "newest" ordering, which sorts on lastSynced.
        created: album.lastSynced.toISOString(),
    };

    if (album.year !== null) {
        formatted.year = album.year;
    }

    if (album.coverUrl || album.location === "FEDERATED") {
        formatted.coverArt = toSubsonicId("album", album.id);
    }

    const genre =
        extractFirstGenreValue(album.userGenres) ??
        extractFirstGenreValue(album.genres);
    if (genre) {
        formatted.genre = genre;
    }

    applyUserEnrichment(formatted, enrichment, false);
    return formatted;
}

type SongForSubsonicInput = {
    id: string;
    title: string;
    trackNo: number;
    discNo: number;
    duration: number;
    fileSize: number;
    mime: string | null;
    filePath: string | null;
    genre?: string | null;
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    album: {
        id: string;
        title: string;
        year: number | null;
        coverUrl: string | null;
        location: AlbumLocation;
        genres?: unknown;
        userGenres?: unknown;
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
        artist: {
            id: string;
            name: string;
        };
    };
};

function formatSongForSubsonic(
    song: SongForSubsonicInput,
    enrichment: SongEnrichment = {},
): Record<string, unknown> {
    if (!isLibrarySurfaceAlbumLocation(song.album.location)) {
        throw new Error("Album location is not visible through Subsonic");
    }
    const suffix =
        song.filePath === null ? undefined : getFileSuffix(song.filePath);

    const formatted: Record<string, unknown> = {
        id: toSubsonicId("track", song.id),
        parent: toSubsonicId("album", song.album.id),
        isDir: false,
        title: song.title,
        album: song.album.title,
        albumId: toSubsonicId("album", song.album.id),
        artist: song.album.artist.name,
        artistId: toSubsonicId("artist", song.album.artist.id),
        track: song.trackNo,
        discNumber: song.discNo,
        duration: song.duration,
        size: song.fileSize,
        contentType: getContentType(song.mime, suffix),
    };

    if (song.album.year !== null) {
        formatted.year = song.album.year;
    }

    if (suffix) {
        formatted.suffix = suffix;
    }

    const bitRate = deriveBitRateKbps(song.fileSize, song.duration);
    if (bitRate !== undefined) {
        formatted.bitRate = bitRate;
    }

    if (song.album.coverUrl || song.album.location === "FEDERATED") {
        formatted.coverArt = toSubsonicId("album", song.album.id);
    }

    const genre =
        song.genre ??
        extractFirstGenreValue(song.album.userGenres) ??
        extractFirstGenreValue(song.album.genres);
    if (genre) {
        formatted.genre = genre;
    }

    const replayGain = formatReplayGain(song);
    if (replayGain) {
        formatted.replayGain = replayGain;
    }

    applyUserEnrichment(formatted, enrichment, true);
    return formatted;
}

function applyUserEnrichment(
    formatted: Record<string, unknown>,
    enrichment: SongEnrichment,
    includeRating: boolean,
): void {
    if (enrichment.playedAt) {
        formatted.played = enrichment.playedAt.toISOString();
    }
    if (enrichment.starredAt) {
        formatted.starred = enrichment.starredAt.toISOString();
    }
    if (includeRating && enrichment.userRating) {
        formatted.userRating = enrichment.userRating;
    }
    if (enrichment.playCount) {
        formatted.playCount = enrichment.playCount;
    }
}

function deriveBitRateKbps(
    fileSizeBytes: number,
    durationSeconds: number,
): number | undefined {
    if (fileSizeBytes <= 0 || durationSeconds <= 0) return undefined;
    const bitRate = Math.round((fileSizeBytes * 8) / durationSeconds / 1000);
    return Number.isSafeInteger(bitRate) && bitRate > 0 ? bitRate : undefined;
}

type ReplayGainSongInput = {
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    album: {
        albumLoudnessLufs?: number | null;
        albumTruePeakDb?: number | null;
    };
};

function formatReplayGain(
    song: ReplayGainSongInput,
): Record<string, number> | null {
    const replayGain = {
        ...(song.loudnessLufs == null
            ? {}
            : { trackGain: formatGain(song.loudnessLufs) }),
        ...(song.album.albumLoudnessLufs == null
            ? {}
            : { albumGain: formatGain(song.album.albumLoudnessLufs) }),
        ...(song.truePeakDb == null
            ? {}
            : { trackPeak: formatPeak(song.truePeakDb) }),
        ...(song.album.albumTruePeakDb == null
            ? {}
            : { albumPeak: formatPeak(song.album.albumTruePeakDb) }),
    };
    return Object.keys(replayGain).length > 0 ? replayGain : null;
}

function formatGain(measuredLufs: number): number {
    return roundDecimal(config.loudnessTargetLufs - measuredLufs, 2);
}

function formatPeak(truePeakDb: number): number {
    return roundDecimal(10 ** (truePeakDb / 20), 6);
}

function roundDecimal(value: number, decimalPlaces: number): number {
    return Number(value.toFixed(decimalPlaces));
}

function formatBookmarkForSubsonic(
    bookmark: {
        positionSeconds: number;
        comment?: string | null;
        createdAt?: Date;
        updatedAt: Date;
        track: BookmarkTrackRecord;
    },
    username: string,
    enrichment?: SongEnrichment,
): Record<string, unknown> {
    const position = Math.round(bookmark.positionSeconds * 1000);
    const createdAt = bookmark.createdAt ?? bookmark.updatedAt;

    return {
        position,
        username,
        comment: bookmark.comment ?? "",
        created: createdAt.toISOString(),
        changed: bookmark.updatedAt.toISOString(),
        entry: {
            ...formatSongForSubsonic(bookmark.track, enrichment),
            bookmarkPosition: position,
        },
    };
}

const bookmarkTrackSelect = Prisma.validator<Prisma.TrackSelect>()({
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

type BookmarkTrackRecord = Prisma.TrackGetPayload<{
    select: typeof bookmarkTrackSelect;
}>;

function parseTrackIdsFromQueryValues(rawIds: string[]): string[] {
    const parsedIds: string[] = [];
    const seen = new Set<string>();

    for (const rawId of rawIds) {
        const trackId = parseSubsonicId(rawId, "track").id;
        if (seen.has(trackId)) {
            continue;
        }
        seen.add(trackId);
        parsedIds.push(trackId);
    }

    return parsedIds;
}

function parseTrackIdsPreserveOrder(rawIds: string[]): string[] {
    return rawIds.map((rawId) => parseSubsonicId(rawId, "track").id);
}

function parseEntityIdsFromQueryValues(
    rawIds: string[],
    entityType: "album" | "artist",
): string[] {
    const parsedIds: string[] = [];
    const seen = new Set<string>();

    for (const rawId of rawIds) {
        const entityId = parseSubsonicId(rawId, entityType).id;
        if (seen.has(entityId)) {
            continue;
        }
        seen.add(entityId);
        parsedIds.push(entityId);
    }

    return parsedIds;
}

/** Checks visible Subsonic tracks through the supplied database scope. */
async function ensureLibraryTracksExist(
    trackIds: string[],
    client: Pick<Prisma.TransactionClient, "track"> = prisma,
): Promise<boolean> {
    if (trackIds.length === 0) {
        return true;
    }

    const tracks = await client.track.findMany({
        where: {
            ...LIBRARY_TRACK_WHERE,
            id: {
                in: trackIds,
            },
            album: {
                location: SUBSONIC_ALBUM_LOCATION_WHERE,
            },
        },
        select: {
            id: true,
        },
    });

    return tracks.length === trackIds.length;
}

async function ensureLibraryAlbumsExist(albumIds: string[]): Promise<boolean> {
    if (albumIds.length === 0) {
        return true;
    }

    const albums = await prisma.album.findMany({
        where: {
            id: {
                in: albumIds,
            },
            ...LIBRARY_ALBUM_WHERE,
        },
        select: {
            id: true,
        },
    });

    return albums.length === albumIds.length;
}

async function ensureLibraryArtistsExist(
    artistIds: string[],
): Promise<boolean> {
    if (artistIds.length === 0) {
        return true;
    }

    const artists = await prisma.artist.findMany({
        where: {
            id: {
                in: artistIds,
            },
            albums: {
                some: LIBRARY_ALBUM_WHERE,
            },
        },
        select: {
            id: true,
        },
    });

    return artists.length === artistIds.length;
}

/** Shared Subsonic route predicates, parsers, ID mapping, and formatters. */
export {
    albumListSelect,
    bookmarkTrackSelect,
    buildAlbumPlayStats,
    combineSongEnrichmentForAlbum,
    DEFAULT_SUBSONIC_AVATAR_PNG,
    ensureLibraryAlbumsExist,
    ensureLibraryArtistsExist,
    ensureLibraryTracksExist,
    extractGenreValues,
    fetchCoverArtBuffer,
    formatAlbumForSubsonic,
    formatArtistForSubsonic,
    formatBookmarkForSubsonic,
    formatSongForSubsonic,
    getQueryValues,
    getRequestContext,
    getRequiredQueryString,
    getRequiredQueryValue,
    isUnsupportedMusicFolderId,
    LIBRARY_ALBUM_WHERE,
    LIBRARY_TRACK_WHERE,
    loadSongEnrichmentByTrackId,
    mapAlbumsForSubsonic,
    normalizeSearchQuery,
    parseAlbumListType,
    parseBookmarkPositionOrError,
    parseCountParam,
    parseEntityIdOrNotFound,
    parseEntityIdsFromQueryValues,
    parseOffsetParam,
    parseSearchCountParam,
    parseSyncedLyricsLines,
    parseTimestampParam,
    parseTrackIdsFromQueryValues,
    parseTrackIdsPreserveOrder,
    parseYearParam,
    PLAYLIST_TRACK_WHERE,
    resolveNativeCoverPath,
    SEARCH_ALBUM_MAX_COUNT,
    SEARCH_ARTIST_MAX_COUNT,
    SEARCH_SONG_MAX_COUNT,
    SONG_LOUDNESS_ALBUM_SELECT,
    SONG_LOUDNESS_TRACK_SELECT,
    shuffleInPlace,
    SUBSONIC_ALBUM_LOCATION_WHERE,
    SUBSONIC_COVER_CACHE_CONTROL,
    SUBSONIC_MUSIC_FOLDER_ID,
};
export type { AlbumListRecord, BookmarkTrackRecord, SongEnrichment };
