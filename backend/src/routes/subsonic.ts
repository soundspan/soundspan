import path from "path";
import fs from "fs";
import { Request, Response, Router } from "express";
import { Prisma } from "@prisma/client";
import { requireSubsonicAuth, subsonicRateLimiter } from "../middleware/subsonicAuth";
import sharp from "sharp";
import { prisma } from "../utils/db";
import {
    getResponseFormat,
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
    type ResponseFormat,
} from "../utils/subsonicResponse";
import { buildArtistIndexes } from "../utils/subsonicIndexes";
import {
    parseSubsonicId,
    SubsonicIdError,
    toSubsonicId,
    type SubsonicEntityType,
} from "../utils/subsonicIds";
import { AudioStreamingService } from "../services/audioStreaming";
import { config } from "../config";
import { BRAND_SLUG, BRAND_USER_AGENT } from "../config/brand";
import { getLyrics } from "../services/lyrics";
import { scanQueue } from "../workers/queues";
import {
    isPublicCoverArtUrl,
    parseCoverArtSize,
    resolveSubsonicStreamQuality,
    resolveTrackPathWithinRoot,
} from "../utils/subsonicMedia";
import { logger } from "../utils/logger";

const router = Router();
const SUBSONIC_TRACE_LOGS = process.env.SUBSONIC_TRACE_LOGS === "true";

const LIBRARY_LOCATION = "LIBRARY";
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

if (SUBSONIC_TRACE_LOGS) {
    router.use((req, res, next) => {
        const startMs = Date.now();
        const client =
            typeof req.query.c === "string" && req.query.c.trim().length > 0
                ? req.query.c
                : "-";
        const version =
            typeof req.query.v === "string" && req.query.v.trim().length > 0
                ? req.query.v
                : "-";
        const format =
            typeof req.query.f === "string" && req.query.f.trim().length > 0
                ? req.query.f
                : typeof req.query.format === "string" &&
                    req.query.format.trim().length > 0
                  ? req.query.format
                  : "-";

        res.on("finish", () => {
            const endpoint = req.path.startsWith("/")
                ? req.path.slice(1)
                : req.path;
            const protocolStatus =
                typeof res.locals?.subsonicProtocolStatus === "string"
                    ? res.locals.subsonicProtocolStatus
                    : "unknown";
            const errorCode =
                typeof res.locals?.subsonicErrorCode === "number"
                    ? ` code=${res.locals.subsonicErrorCode}`
                    : "";

            logger.warn(
                `[SubsonicTrace] ${req.method} ${endpoint || "(root)"} c=${client} v=${version} f=${format} http=${res.statusCode} proto=${protocolStatus}${errorCode} ${Date.now() - startMs}ms`,
            );
        });

        next();
    });
}

router.use(subsonicRateLimiter);
router.use(requireSubsonicAuth);

function getCallback(req: Request): string | undefined {
    return typeof req.query.callback === "string" ? req.query.callback : undefined;
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

function parseSearchCountParam(value: unknown, fallback: number, max: number): number {
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
    return musicFolderId.length > 0 && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID;
}

function normalizeSearchQuery(rawQuery: string): string {
    const trimmed = rawQuery.trim();
    if (trimmed.length >= 2) {
        const firstChar = trimmed.charAt(0);
        const lastChar = trimmed.charAt(trimmed.length - 1);
        if ((firstChar === `"` || firstChar === "'") && firstChar === lastChar) {
            return trimmed.slice(1, -1).trim();
        }
    }

    return trimmed;
}

const albumListSelect = Prisma.validator<Prisma.AlbumSelect>()({
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
        select: {
            duration: true,
        },
    },
});

type AlbumListRecord = Prisma.AlbumGetPayload<{ select: typeof albumListSelect }>;

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

function mapAlbumsForSubsonic(albums: AlbumListRecord[]): Record<string, unknown>[] {
    return albums.map((album) =>
        formatAlbumForSubsonic({
            id: album.id,
            title: album.title,
            year: album.year,
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

async function buildAlbumPlayStats(userId: string): Promise<Map<string, AlbumPlayStat>> {
    const groupedPlays = await prisma.play.groupBy({
        by: ["trackId"],
        where: {
            userId,
            track: {
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
        },
        _count: {
            _all: true,
        },
        _max: {
            playedAt: true,
        },
    });

    if (groupedPlays.length === 0) {
        return new Map();
    }

    const trackIds = groupedPlays.map((entry) => entry.trackId);
    const tracks = await prisma.track.findMany({
        where: {
            id: {
                in: trackIds,
            },
            album: {
                location: LIBRARY_LOCATION,
            },
        },
        select: {
            id: true,
            albumId: true,
        },
    });

    const albumIdByTrackId = new Map(
        tracks.map((track) => [track.id, track.albumId]),
    );

    const albumStats = new Map<string, AlbumPlayStat>();

    for (const entry of groupedPlays) {
        const albumId = albumIdByTrackId.get(entry.trackId);
        if (!albumId) {
            continue;
        }

        const currentStat = albumStats.get(albumId);
        const playCount = entry._count._all;
        const lastPlayed = entry._max.playedAt ?? null;

        if (!currentStat) {
            albumStats.set(albumId, {
                playCount,
                lastPlayed,
            });
            continue;
        }

        currentStat.playCount += playCount;
        if (lastPlayed && (!currentStat.lastPlayed || lastPlayed > currentStat.lastPlayed)) {
            currentStat.lastPlayed = lastPlayed;
        }
    }

    return albumStats;
}

function getQueryValues(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string");
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
    const response = await fetch(url, {
        headers: {
            "User-Agent": BRAND_USER_AGENT,
        },
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`COVER_FETCH_FAILED:${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    return {
        buffer: Buffer.from(arrayBuffer),
        contentType,
    };
}

async function maybeResizeCoverArt(
    buffer: Buffer,
    contentType: string,
    size?: number,
): Promise<{ buffer: Buffer; contentType: string }> {
    if (!size) {
        return { buffer, contentType };
    }

    try {
        const isPng = contentType.toLowerCase().includes("png");
        const resized = isPng
            ? await sharp(buffer)
                .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
                .png()
                .toBuffer()
            : await sharp(buffer)
                .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();

        return {
            buffer: resized,
            contentType: isPng ? "image/png" : "image/jpeg",
        };
    } catch {
        return { buffer, contentType };
    }
}

function resolveNativeCoverPath(nativeCoverPath: string): string | null {
    const coverRoot = path.resolve(path.join(config.music.transcodeCachePath, "../covers"));
    const resolvedPath = path.resolve(path.join(coverRoot, nativeCoverPath));

    if (
        resolvedPath !== coverRoot &&
        !resolvedPath.startsWith(`${coverRoot}${path.sep}`)
    ) {
        return null;
    }

    return resolvedPath;
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

function formatAlbumForSubsonic(album: {
    id: string;
    title: string;
    year: number | null;
    coverUrl: string | null;
    genres?: unknown;
    userGenres?: unknown;
    artist: {
        id: string;
        name: string;
    };
    songCount: number;
    duration: number;
}): Record<string, unknown> {
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
    };

    if (album.year !== null) {
        formatted.year = album.year;
    }

    if (album.coverUrl) {
        formatted.coverArt = toSubsonicId("album", album.id);
    }

    const genre =
        extractFirstGenreValue(album.userGenres) ??
        extractFirstGenreValue(album.genres);
    if (genre) {
        formatted.genre = genre;
    }

    return formatted;
}

function formatSongForSubsonic(song: {
    id: string;
    title: string;
    trackNo: number;
    discNo: number;
    duration: number;
    fileSize: number;
    mime: string | null;
    filePath: string;
    genre?: string | null;
    album: {
        id: string;
        title: string;
        year: number | null;
        coverUrl: string | null;
        genres?: unknown;
        userGenres?: unknown;
        artist: {
            id: string;
            name: string;
        };
    };
}): Record<string, unknown> {
    const suffix = getFileSuffix(song.filePath);

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

    if (song.album.coverUrl) {
        formatted.coverArt = toSubsonicId("album", song.album.id);
    }

    const genre =
        song.genre ??
        extractFirstGenreValue(song.album.userGenres) ??
        extractFirstGenreValue(song.album.genres);
    if (genre) {
        formatted.genre = genre;
    }

    return formatted;
}

export function handlePing(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(res, { ping: {} }, format, callback);
}

export function handleGetLicense(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(
        res,
        {
            license: {
                valid: true,
                email: `self-hosted@${BRAND_SLUG}.local`,
            },
        },
        format,
        callback,
    );
}

export function handleGetOpenSubsonicExtensions(
    req: Request,
    res: Response,
): void {
    const { format, callback } = getRequestContext(req);
    sendSubsonicSuccess(
        res,
        {
            openSubsonicExtensions: {
                openSubsonicExtension: [
                    { name: "apiKeyAuthentication", versions: [1] },
                    { name: "formPost", versions: [1] },
                    { name: "songLyrics", versions: [1] },
                    { name: "transcodeOffset", versions: [1] },
                    { name: "songPlayedDate", versions: [1] },
                    { name: "albumPlayedDate", versions: [1] },
                ],
            },
        },
        format,
        callback,
    );
}

export function handleTokenInfo(req: Request, res: Response): void {
    const { format, callback } = getRequestContext(req);
    const hasApiKey = typeof req.query.apiKey === "string" && req.query.apiKey.length > 0;
    const hasToken = typeof req.query.t === "string" && req.query.t.length > 0;

    sendSubsonicSuccess(
        res,
        {
            tokenInfo: {
                valid: true,
                username: req.user?.username,
                authType: hasApiKey ? "apiKey" : hasToken ? "token" : "password",
            },
        },
        format,
        callback,
    );
}

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

export async function handleGetIndexes(req: Request, res: Response): Promise<void> {
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
                    some: {
                        location: LIBRARY_LOCATION,
                    },
                },
            },
            select: {
                id: true,
                name: true,
                heroUrl: true,
                lastSynced: true,
                _count: {
                    select: {
                        albums: true,
                    },
                },
            },
            orderBy: { name: "asc" },
        });

        const lastModified = artists.reduce((latest, artist) => {
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
                coverArtId: artist.heroUrl ? toSubsonicId("artist", artist.id) : undefined,
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

export async function handleGetArtists(req: Request, res: Response): Promise<void> {
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
                    some: {
                        location: LIBRARY_LOCATION,
                    },
                },
            },
            select: {
                id: true,
                name: true,
                heroUrl: true,
                _count: {
                    select: {
                        albums: true,
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
                coverArtId: artist.heroUrl ? toSubsonicId("artist", artist.id) : undefined,
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

export async function handleGetArtist(req: Request, res: Response): Promise<void> {
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
                    some: {
                        location: LIBRARY_LOCATION,
                    },
                },
            },
            select: {
                id: true,
                name: true,
                heroUrl: true,
                albums: {
                    where: {
                        location: LIBRARY_LOCATION,
                    },
                    select: {
                        id: true,
                        title: true,
                        year: true,
                        coverUrl: true,
                        genres: true,
                        userGenres: true,
                        tracks: {
                            select: {
                                duration: true,
                            },
                        },
                        _count: {
                            select: {
                                tracks: true,
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

export async function handleGetAlbum(req: Request, res: Response): Promise<void> {
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
                location: LIBRARY_LOCATION,
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

export async function handleGetSong(req: Request, res: Response): Promise<void> {
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
                id: trackId,
                album: {
                    location: LIBRARY_LOCATION,
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

export async function handleSearch3(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawQuery = getRequiredQueryValue(req, res, "query", format, callback);
    if (rawQuery === null) {
        return;
    }

    if (isUnsupportedMusicFolderId(req.query.musicFolderId)) {
        sendSubsonicSuccess(
            res,
            {
                searchResult3: {
                    artist: [],
                    album: [],
                    song: [],
                },
            },
            format,
            callback,
        );
        return;
    }

    const query = normalizeSearchQuery(rawQuery);

    const artistCount = parseSearchCountParam(
        req.query.artistCount,
        20,
        SEARCH_ARTIST_MAX_COUNT,
    );
    const albumCount = parseSearchCountParam(
        req.query.albumCount,
        20,
        SEARCH_ALBUM_MAX_COUNT,
    );
    const songCount = parseSearchCountParam(
        req.query.songCount,
        20,
        SEARCH_SONG_MAX_COUNT,
    );

    const artistOffset = parseOffsetParam(req.query.artistOffset);
    const albumOffset = parseOffsetParam(req.query.albumOffset);
    const songOffset = parseOffsetParam(req.query.songOffset);

    try {
        const [artists, albums, tracks] = await Promise.all([
            prisma.artist.findMany({
                where: {
                    albums: {
                        some: {
                            location: LIBRARY_LOCATION,
                        },
                    },
                    ...(query
                        ? {
                            name: {
                                contains: query,
                                mode: "insensitive" as const,
                            },
                        }
                        : {}),
                },
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: true,
                        },
                    },
                },
                orderBy: {
                    name: "asc",
                },
                take: artistCount,
                skip: artistOffset,
            }),
            prisma.album.findMany({
                where: {
                    location: LIBRARY_LOCATION,
                    ...(query
                        ? {
                            OR: [
                                {
                                    title: {
                                        contains: query,
                                        mode: "insensitive" as const,
                                    },
                                },
                                {
                                    artist: {
                                        name: {
                                            contains: query,
                                            mode: "insensitive" as const,
                                        },
                                    },
                                },
                            ],
                        }
                        : {}),
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
                        select: {
                            duration: true,
                        },
                    },
                    _count: {
                        select: {
                            tracks: true,
                        },
                    },
                },
                orderBy: {
                    title: "asc",
                },
                take: albumCount,
                skip: albumOffset,
            }),
            prisma.track.findMany({
                where: {
                    album: {
                        location: LIBRARY_LOCATION,
                    },
                    ...(query
                        ? {
                            OR: [
                                {
                                    title: {
                                        contains: query,
                                        mode: "insensitive" as const,
                                    },
                                },
                                {
                                    album: {
                                        title: {
                                            contains: query,
                                            mode: "insensitive" as const,
                                        },
                                    },
                                },
                                {
                                    album: {
                                        artist: {
                                            name: {
                                                contains: query,
                                                mode: "insensitive" as const,
                                            },
                                        },
                                    },
                                },
                            ],
                        }
                        : {}),
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
                orderBy: [{ title: "asc" }, { id: "asc" }],
                take: songCount,
                skip: songOffset,
            }),
        ]);

        sendSubsonicSuccess(
            res,
            {
                searchResult3: {
                    artist: artists.map((artist) =>
                        formatArtistForSubsonic({
                            id: artist.id,
                            name: artist.name,
                            albumCount: artist._count.albums,
                            heroUrl: artist.heroUrl,
                        }),
                    ),
                    album: albums.map((album) =>
                        formatAlbumForSubsonic({
                            id: album.id,
                            title: album.title,
                            year: album.year,
                            coverUrl: album.coverUrl,
                            genres: album.genres,
                            userGenres: album.userGenres,
                            artist: album.artist,
                            songCount: album._count.tracks,
                            duration: album.tracks.reduce(
                                (sum, track) => sum + (track.duration ?? 0),
                                0,
                            ),
                        }),
                    ),
                    song: tracks.map((track) => formatSongForSubsonic(track)),
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to search",
            format,
            callback,
        );
    }
}

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
                    some: {
                        location: LIBRARY_LOCATION,
                    },
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
                                    where: {
                                        location: LIBRARY_LOCATION,
                                    },
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
                location: LIBRARY_LOCATION,
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
                albumInfo2: {
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

async function findSimilarArtistIds(
    artistId: string,
): Promise<string[]> {
    const artist = await prisma.artist.findFirst({
        where: {
            id: artistId,
            albums: {
                some: {
                    location: LIBRARY_LOCATION,
                },
            },
        },
        select: {
            similarFrom: {
                select: {
                    toArtist: {
                        select: {
                            id: true,
                            albums: {
                                where: {
                                    location: LIBRARY_LOCATION,
                                },
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
        typeof req.query.musicFolderId === "string" ? req.query.musicFolderId : "";

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
                    some: {
                        location: LIBRARY_LOCATION,
                    },
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
                album: {
                    location: LIBRARY_LOCATION,
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

        const songs = tracks
            .sort((left, right) => {
                const leftRank =
                    similarArtistRank.get(left.album.artist.id) ?? Number.MAX_SAFE_INTEGER;
                const rightRank =
                    similarArtistRank.get(right.album.artist.id) ?? Number.MAX_SAFE_INTEGER;
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
            .slice(0, count)
            .map((track) => formatSongForSubsonic(track));

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
        typeof req.query.musicFolderId === "string" ? req.query.musicFolderId : "";

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
                id: trackId,
                album: {
                    location: LIBRARY_LOCATION,
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
                        id: {
                            not: trackId,
                        },
                        album: {
                            location: LIBRARY_LOCATION,
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
                        id: {
                            not: trackId,
                        },
                        album: {
                            location: LIBRARY_LOCATION,
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
                id: {
                    not: trackId,
                },
                album: {
                    location: LIBRARY_LOCATION,
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

        sendSubsonicSuccess(
            res,
            {
                similarSongs2: {
                    song: mergedTracks
                        .slice(0, count)
                        .map((track) => formatSongForSubsonic(track)),
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
                    some: {
                        location: LIBRARY_LOCATION,
                    },
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
                some: {
                    location: LIBRARY_LOCATION,
                },
            },
        },
        select: {
            id: true,
            name: true,
        },
    });

    return artistByName ?? null;
}

export async function handleGetTopSongs(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const artistParam = getRequiredQueryString(req, res, "artist", format, callback);
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
                    album: {
                        artistId: artist.id,
                        location: LIBRARY_LOCATION,
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
                album: {
                    artistId: artist.id,
                    location: LIBRARY_LOCATION,
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

        const topSongs = tracks
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
            .slice(0, 50)
            .map((track) => formatSongForSubsonic(track));

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

async function handleSearchLike(
    req: Request,
    res: Response,
    responseKey: "searchResult" | "searchResult2",
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawQuery = getRequiredQueryValue(req, res, "query", format, callback);
    if (rawQuery === null) {
        return;
    }

    if (isUnsupportedMusicFolderId(req.query.musicFolderId)) {
        const payload: Record<string, unknown> = {};
        payload[responseKey] = {
            artist: [],
            album: [],
            song: [],
        };

        sendSubsonicSuccess(
            res,
            payload,
            format,
            callback,
        );
        return;
    }

    const query = normalizeSearchQuery(rawQuery);

    const artistCount = parseSearchCountParam(
        req.query.artistCount,
        20,
        SEARCH_ARTIST_MAX_COUNT,
    );
    const albumCount = parseSearchCountParam(
        req.query.albumCount,
        20,
        SEARCH_ALBUM_MAX_COUNT,
    );
    const songCount = parseSearchCountParam(
        req.query.songCount,
        20,
        SEARCH_SONG_MAX_COUNT,
    );

    const artistOffset = parseOffsetParam(req.query.artistOffset);
    const albumOffset = parseOffsetParam(req.query.albumOffset);
    const songOffset = parseOffsetParam(req.query.songOffset);

    try {
        const [artists, albums, tracks] = await Promise.all([
            prisma.artist.findMany({
                where: {
                    albums: {
                        some: {
                            location: LIBRARY_LOCATION,
                        },
                    },
                    ...(query
                        ? {
                            name: {
                                contains: query,
                                mode: "insensitive" as const,
                            },
                        }
                        : {}),
                },
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: true,
                        },
                    },
                },
                orderBy: {
                    name: "asc",
                },
                take: artistCount,
                skip: artistOffset,
            }),
            prisma.album.findMany({
                where: {
                    location: LIBRARY_LOCATION,
                    ...(query
                        ? {
                            OR: [
                                {
                                    title: {
                                        contains: query,
                                        mode: "insensitive" as const,
                                    },
                                },
                                {
                                    artist: {
                                        name: {
                                            contains: query,
                                            mode: "insensitive" as const,
                                        },
                                    },
                                },
                            ],
                        }
                        : {}),
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
                        select: {
                            duration: true,
                        },
                    },
                    _count: {
                        select: {
                            tracks: true,
                        },
                    },
                },
                orderBy: {
                    title: "asc",
                },
                take: albumCount,
                skip: albumOffset,
            }),
            prisma.track.findMany({
                where: {
                    album: {
                        location: LIBRARY_LOCATION,
                    },
                    ...(query
                        ? {
                            OR: [
                                {
                                    title: {
                                        contains: query,
                                        mode: "insensitive" as const,
                                    },
                                },
                                {
                                    album: {
                                        title: {
                                            contains: query,
                                            mode: "insensitive" as const,
                                        },
                                    },
                                },
                                {
                                    album: {
                                        artist: {
                                            name: {
                                                contains: query,
                                                mode: "insensitive" as const,
                                            },
                                        },
                                    },
                                },
                            ],
                        }
                        : {}),
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
                orderBy: [{ title: "asc" }, { id: "asc" }],
                take: songCount,
                skip: songOffset,
            }),
        ]);

        const searchResultPayload = {
            artist: artists.map((artist) =>
                formatArtistForSubsonic({
                    id: artist.id,
                    name: artist.name,
                    albumCount: artist._count.albums,
                    heroUrl: artist.heroUrl,
                }),
            ),
            album: albums.map((album) =>
                formatAlbumForSubsonic({
                    id: album.id,
                    title: album.title,
                    year: album.year,
                    coverUrl: album.coverUrl,
                    genres: album.genres,
                    userGenres: album.userGenres,
                    artist: album.artist,
                    songCount: album._count.tracks,
                    duration: album.tracks.reduce(
                        (sum, track) => sum + (track.duration ?? 0),
                        0,
                    ),
                }),
            ),
            song: tracks.map((track) => formatSongForSubsonic(track)),
        };

        const payload: Record<string, unknown> = {};
        payload[responseKey] = searchResultPayload;

        sendSubsonicSuccess(
            res,
            payload,
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to search",
            format,
            callback,
        );
    }
}

export async function handleSearch(req: Request, res: Response): Promise<void> {
    await handleSearchLike(req, res, "searchResult");
}

export async function handleSearch2(req: Request, res: Response): Promise<void> {
    await handleSearchLike(req, res, "searchResult2");
}

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
        typeof req.query.musicFolderId === "string" ? req.query.musicFolderId : "";

    if (musicFolderId && musicFolderId !== SUBSONIC_MUSIC_FOLDER_ID) {
        const payload: Record<string, unknown> = {};
        payload[responseKey] = {
            album: [],
        };

        sendSubsonicSuccess(
            res,
            payload,
            format,
            callback,
        );
        return;
    }

    try {
        let albums: AlbumListRecord[] = [];

        if (type === "starred") {
            albums = [];
        } else if (type === "random") {
            const candidates = await prisma.album.findMany({
                where: {
                    location: LIBRARY_LOCATION,
                },
                select: albumListSelect,
                orderBy: {
                    id: "asc",
                },
                take: 500,
            });
            shuffleInPlace(candidates);
            albums = candidates.slice(offset, offset + size);
        } else if (type === "frequent" || type === "highest" || type === "recent") {
            const albumStats = await buildAlbumPlayStats(req.user!.id);
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
                        location: LIBRARY_LOCATION,
                    },
                    select: albumListSelect,
                });

                const albumById = new Map(
                    fetchedAlbums.map((album) => [album.id, album]),
                );
                albums = pagedAlbumIds
                    .map((albumId) => albumById.get(albumId))
                    .filter((album): album is AlbumListRecord => Boolean(album));
            }
        } else {
            const where: Prisma.AlbumWhereInput = {
                location: LIBRARY_LOCATION,
            };
            let orderBy: Prisma.AlbumOrderByWithRelationInput[] = [
                { title: "asc" },
                { id: "asc" },
            ];

            if (type === "newest") {
                orderBy = [{ lastSynced: "desc" }, { title: "asc" }, { id: "asc" }];
            } else if (type === "alphabeticalByArtist") {
                orderBy = [{ artist: { name: "asc" } }, { title: "asc" }, { id: "asc" }];
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

                where.tracks = {
                    some: {
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
        payload[responseKey] = {
            album: mapAlbumsForSubsonic(albums),
        };

        sendSubsonicSuccess(
            res,
            payload,
            format,
            callback,
        );
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

export async function handleGetAlbumList(req: Request, res: Response): Promise<void> {
    await handleGetAlbumListLike(req, res, "albumList");
}

export async function handleGetAlbumList2(req: Request, res: Response): Promise<void> {
    await handleGetAlbumListLike(req, res, "albumList2");
}

async function getRootMusicDirectoryChildren(): Promise<Record<string, unknown>[]> {
    const artists = await prisma.artist.findMany({
        where: {
            albums: {
                some: {
                    location: LIBRARY_LOCATION,
                },
            },
        },
        select: {
            id: true,
            name: true,
            heroUrl: true,
            albums: {
                where: {
                    location: LIBRARY_LOCATION,
                },
                select: {
                    id: true,
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
            albumCount: artist.albums.length,
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
                some: {
                    location: LIBRARY_LOCATION,
                },
            },
        },
        select: {
            id: true,
            name: true,
            albums: {
                where: {
                    location: LIBRARY_LOCATION,
                },
                select: {
                    id: true,
                    title: true,
                    year: true,
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    tracks: {
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
            location: LIBRARY_LOCATION,
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

export async function handleGetGenres(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const genres = await prisma.genre.findMany({
            where: {
                trackGenres: {
                    some: {
                        track: {
                            album: {
                                location: LIBRARY_LOCATION,
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
                            album: {
                                location: LIBRARY_LOCATION,
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
                            genre.trackGenres.map((entry) => entry.track.albumId),
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
        typeof req.query.musicFolderId === "string" ? req.query.musicFolderId : "";

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
        const tracks = await prisma.track.findMany({
            where: {
                album: {
                    location: LIBRARY_LOCATION,
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
            orderBy: [{ title: "asc" }, { id: "asc" }],
            skip: offset,
            take: count,
        });

        sendSubsonicSuccess(
            res,
            {
                songsByGenre: {
                    song: tracks.map((track) =>
                        formatSongForSubsonic({
                            ...track,
                            genre,
                        }),
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

export async function handleGetRandomSongs(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const size = parseCountParam(req.query.size, 10, 500);
    const musicFolderId =
        typeof req.query.musicFolderId === "string" ? req.query.musicFolderId : "";
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
            album: {
                location: LIBRARY_LOCATION,
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
                location: LIBRARY_LOCATION,
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
            orderBy: {
                id: "asc",
            },
            take: 5000,
        });

        shuffleInPlace(candidates);
        const songs = candidates
            .slice(0, size)
            .map((track) =>
                formatSongForSubsonic({
                    ...track,
                    genre: genre || undefined,
                }),
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

type ScanQueueJobLike = {
    progress?: () => unknown;
};

const SUBSONIC_SCAN_START_COOLDOWN_MS = 30 * 60 * 1000;
let lastSubsonicScanStartRequestAt = 0;

function parseScanProgressCount(job: ScanQueueJobLike | undefined): number {
    if (!job || typeof job.progress !== "function") {
        return 0;
    }

    const value = job.progress();
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(value)));
}

function canQueueSubsonicScan(nowMs: number): boolean {
    return (
        lastSubsonicScanStartRequestAt === 0 ||
        nowMs - lastSubsonicScanStartRequestAt >=
            SUBSONIC_SCAN_START_COOLDOWN_MS
    );
}

export function resetSubsonicScanStartCooldownForTests(): void {
    lastSubsonicScanStartRequestAt = 0;
}

export async function handleGetPlayQueue(req: Request, res: Response): Promise<void> {
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

        const queueItems = Array.isArray(state?.queue)
            ? state.queue
            : [];

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
        const tracks = uniqueTrackIds.length > 0
            ? await prisma.track.findMany({
                where: {
                    id: {
                        in: uniqueTrackIds,
                    },
                    album: {
                        location: LIBRARY_LOCATION,
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
            .filter((track): track is NonNullable<typeof track> => Boolean(track))
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

export async function handleSavePlayQueue(req: Request, res: Response): Promise<void> {
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

        const tracks = uniqueTrackIds.length > 0
            ? await prisma.track.findMany({
                where: {
                    id: {
                        in: uniqueTrackIds,
                    },
                    album: {
                        location: LIBRARY_LOCATION,
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
            .filter((track): track is NonNullable<typeof track> => Boolean(track))
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
        const currentTrackId = queue.length > 0
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

export async function handleGetPlayQueueByIndex(
    req: Request,
    res: Response,
): Promise<void> {
    await handleGetPlayQueue(req, res);
}

export async function handleSavePlayQueueByIndex(
    req: Request,
    res: Response,
): Promise<void> {
    await handleSavePlayQueue(req, res);
}

export async function handleGetBookmarks(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    sendSubsonicSuccess(
        res,
        {
            bookmarks: {
                bookmark: [],
            },
        },
        format,
        callback,
    );
}

export async function handleCreateBookmark(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    // Bookmark persistence is currently not modeled in soundspan. Return a
    // protocol-success no-op for compatibility clients that expect this endpoint.
    sendSubsonicSuccess(res, {}, format, callback);
}

export async function handleDeleteBookmark(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    // Bookmark persistence is currently not modeled in soundspan. Return a
    // protocol-success no-op for compatibility clients that expect this endpoint.
    sendSubsonicSuccess(res, {}, format, callback);
}

export async function handleGetScanStatus(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const activeJobs = await scanQueue.getActive();

        const scanning = activeJobs.length > 0;
        const count = scanning
            ? parseScanProgressCount(activeJobs[0] as ScanQueueJobLike)
            : 0;
        sendSubsonicSuccess(
            res,
            {
                scanStatus: {
                    scanning,
                    count,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch scan status",
            format,
            callback,
        );
    }
}

export async function handleStartScan(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const nowMs = Date.now();
        const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
            scanQueue.getActive(),
            scanQueue.getWaiting(),
            scanQueue.getDelayed(),
        ]);

        const hasPendingScan =
            activeJobs.length > 0 ||
            waitingJobs.length > 0 ||
            delayedJobs.length > 0;
        const queuedNow = !hasPendingScan && canQueueSubsonicScan(nowMs);

        if (queuedNow) {
            await scanQueue.add(
                "scan",
                {
                    userId: req.user!.id,
                    musicPath: config.music.musicPath,
                },
                {
                    removeOnComplete: true,
                    removeOnFail: 50,
                },
            );
            lastSubsonicScanStartRequestAt = nowMs;
        }

        const activeCount = parseScanProgressCount(activeJobs[0] as ScanQueueJobLike);
        sendSubsonicSuccess(
            res,
            {
                scanStatus: {
                    scanning: activeJobs.length > 0 || queuedNow,
                    count: activeCount,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to start scan",
            format,
            callback,
        );
    }
}

async function resolveCoverArtUrl(
    type: SubsonicEntityType | undefined,
    entityId: string,
    userId: string,
): Promise<string | null> {
    if (type === "album") {
        const album = await prisma.album.findFirst({
            where: {
                id: entityId,
                location: LIBRARY_LOCATION,
            },
            select: {
                coverUrl: true,
                genres: true,
                userGenres: true,
            },
        });
        return album?.coverUrl ?? null;
    }

    if (type === "artist") {
        const artist = await prisma.artist.findFirst({
            where: {
                id: entityId,
                albums: {
                    some: {
                        location: LIBRARY_LOCATION,
                    },
                },
            },
            select: {
                heroUrl: true,
            },
        });
        return artist?.heroUrl ?? null;
    }

    if (type === "track") {
        const track = await prisma.track.findFirst({
            where: {
                id: entityId,
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
            select: {
                album: {
                    select: {
                        coverUrl: true,
                        genres: true,
                        userGenres: true,
                    },
                },
            },
        });
        return track?.album.coverUrl ?? null;
    }

    if (type === "playlist") {
        const playlist = await prisma.playlist.findFirst({
            where: {
                id: entityId,
                userId,
            },
            select: {
                items: {
                    where: {
                        track: {
                            album: {
                                location: LIBRARY_LOCATION,
                            },
                        },
                    },
                    orderBy: { sort: "asc" },
                    select: {
                        track: {
                            select: {
                                album: {
                                    select: {
                                        coverUrl: true,
                                        genres: true,
                                        userGenres: true,
                                    },
                                },
                            },
                        },
                    },
                    take: 10,
                },
            },
        });

        const firstCover = playlist?.items
            .map((item) => item.track?.album.coverUrl ?? null)
            .find((coverUrl): coverUrl is string => Boolean(coverUrl));
        return firstCover ?? null;
    }

    const [album, artist, track, playlist] = await Promise.all([
        prisma.album.findFirst({
            where: {
                id: entityId,
                location: LIBRARY_LOCATION,
            },
            select: {
                coverUrl: true,
                genres: true,
                userGenres: true,
            },
        }),
        prisma.artist.findFirst({
            where: {
                id: entityId,
                albums: {
                    some: {
                        location: LIBRARY_LOCATION,
                    },
                },
            },
            select: {
                heroUrl: true,
            },
        }),
        prisma.track.findFirst({
            where: {
                id: entityId,
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
            select: {
                album: {
                    select: {
                        coverUrl: true,
                        genres: true,
                        userGenres: true,
                    },
                },
            },
        }),
        prisma.playlist.findFirst({
            where: {
                id: entityId,
                userId,
            },
            select: {
                items: {
                    where: {
                        track: {
                            album: {
                                location: LIBRARY_LOCATION,
                            },
                        },
                    },
                    orderBy: { sort: "asc" },
                    select: {
                        track: {
                            select: {
                                album: {
                                    select: {
                                        coverUrl: true,
                                        genres: true,
                                        userGenres: true,
                                    },
                                },
                            },
                        },
                    },
                    take: 10,
                },
            },
        }),
    ]);

    const playlistCover = playlist?.items
        .map((item) => item.track?.album.coverUrl ?? null)
        .find((coverUrl): coverUrl is string => Boolean(coverUrl));

    return (
        album?.coverUrl ??
        artist?.heroUrl ??
        track?.album.coverUrl ??
        playlistCover ??
        null
    );
}

export async function handleStream(req: Request, res: Response): Promise<void> {
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

    const quality = resolveSubsonicStreamQuality(req.query.maxBitRate, req.query.format);

    let streamingService: AudioStreamingService | null = null;

    try {
        const track = await prisma.track.findFirst({
            where: {
                id: trackId,
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
            select: {
                id: true,
                filePath: true,
                fileModified: true,
            },
        });

        if (!track || !track.filePath || !track.fileModified) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }

        const absolutePath = resolveTrackPathWithinRoot(
            config.music.musicPath,
            track.filePath,
        );

        if (!absolutePath || !fs.existsSync(absolutePath)) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "File not found",
                format,
                callback,
            );
            return;
        }

        streamingService = new AudioStreamingService(
            config.music.musicPath,
            config.music.transcodeCachePath,
            config.music.transcodeCacheMaxGb,
        );

        let streamFile;
        if (quality === "original") {
            streamFile = await streamingService.getStreamFilePath(
                track.id,
                quality,
                track.fileModified,
                absolutePath,
            );
        } else {
            try {
                streamFile = await streamingService.getStreamFilePath(
                    track.id,
                    quality,
                    track.fileModified,
                    absolutePath,
                );
            } catch (error) {
                if ((error as { code?: string }).code === "FFMPEG_NOT_FOUND") {
                    streamFile = await streamingService.getStreamFilePath(
                        track.id,
                        "original",
                        track.fileModified,
                        absolutePath,
                    );
                } else {
                    throw error;
                }
            }
        }

        await streamingService.streamFileWithRangeSupport(
            req,
            res,
            streamFile.filePath,
            streamFile.mimeType,
        );
    } catch {
        if (!res.headersSent) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.GENERIC,
                "Failed to stream",
                format,
                callback,
            );
        }
    } finally {
        streamingService?.destroy();
    }
}

export async function handleDownload(req: Request, res: Response): Promise<void> {
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
                id: trackId,
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
            select: {
                filePath: true,
            },
        });

        if (!track || !track.filePath) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }

        const absolutePath = resolveTrackPathWithinRoot(
            config.music.musicPath,
            track.filePath,
        );

        if (!absolutePath || !fs.existsSync(absolutePath)) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "File not found",
                format,
                callback,
            );
            return;
        }

        res.download(absolutePath, path.basename(track.filePath));
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to download",
            format,
            callback,
        );
    }
}

export async function handleGetLyrics(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawArtist =
        typeof req.query.artist === "string" ? req.query.artist.trim() : "";
    const rawTitle =
        typeof req.query.title === "string" ? req.query.title.trim() : "";

    if (!rawArtist && !rawTitle) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'artist' or 'title' is missing",
            format,
            callback,
        );
        return;
    }

    try {
        const track = await prisma.track.findFirst({
            where: {
                title: rawTitle
                    ? {
                        contains: rawTitle,
                        mode: "insensitive",
                    }
                    : undefined,
                album: {
                    location: LIBRARY_LOCATION,
                    artist: rawArtist
                        ? {
                            name: {
                                contains: rawArtist,
                                mode: "insensitive",
                            },
                        }
                        : undefined,
                },
            },
            select: {
                id: true,
                title: true,
                album: {
                    select: {
                        artist: {
                            select: {
                                name: true,
                            },
                        },
                    },
                },
            },
            orderBy: [{ title: "asc" }, { id: "asc" }],
        });

        if (!track) {
            sendSubsonicSuccess(
                res,
                {
                    lyrics: {
                        artist: rawArtist,
                        title: rawTitle,
                        value: "",
                    },
                },
                format,
                callback,
            );
            return;
        }

        const lyrics = await getLyrics(track.id);
        const syncedAsPlain = lyrics.syncedLyrics
            ? parseSyncedLyricsLines(lyrics.syncedLyrics)
                .map((line) => line.value)
                .filter((line) => line.length > 0)
                .join("\n")
            : "";
        const lyricsValue = lyrics.plainLyrics ?? syncedAsPlain;

        sendSubsonicSuccess(
            res,
            {
                lyrics: {
                    artist: track.album.artist.name,
                    title: track.title,
                    value: lyricsValue ?? "",
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch lyrics",
            format,
            callback,
        );
    }
}

export async function handleGetLyricsBySongId(
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
                id: trackId,
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
            select: {
                title: true,
                album: {
                    select: {
                        artist: {
                            select: {
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

        const lyrics = await getLyrics(trackId);
        if (!lyrics.syncedLyrics && !lyrics.plainLyrics) {
            sendSubsonicSuccess(
                res,
                {
                    lyricsList: {
                        structuredLyrics: [],
                    },
                },
                format,
                callback,
            );
            return;
        }

        const line = lyrics.syncedLyrics
            ? parseSyncedLyricsLines(lyrics.syncedLyrics)
            : [
                {
                    value: lyrics.plainLyrics ?? "",
                    start: 0,
                },
            ];

        sendSubsonicSuccess(
            res,
            {
                lyricsList: {
                    structuredLyrics: [
                        {
                            displayArtist: track.album.artist.name,
                            displayTitle: track.title,
                            lang: "",
                            synced: Boolean(lyrics.syncedLyrics),
                            offset: 0,
                            line,
                        },
                    ],
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch lyrics",
            format,
            callback,
        );
    }
}

export async function handleGetCoverArt(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const requestedSize = parseCoverArtSize(req.query.size);

    let type: SubsonicEntityType | undefined;
    let entityId = rawId;

    try {
        const parsed = parseSubsonicId(rawId);
        type = parsed.type;
        entityId = parsed.id;
    } catch {
        entityId = rawId.trim();
    }

    try {
        const coverUrl = await resolveCoverArtUrl(type, entityId, req.user!.id);
        if (!coverUrl) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Cover art not found",
                format,
                callback,
            );
            return;
        }

        let imageBuffer: Buffer;
        let contentType = "image/jpeg";

        if (coverUrl.startsWith("native:")) {
            const nativePath = coverUrl.slice("native:".length);
            const resolvedNativePath = resolveNativeCoverPath(nativePath);

            if (!resolvedNativePath || !fs.existsSync(resolvedNativePath)) {
                sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Cover art not found",
                    format,
                    callback,
                );
                return;
            }

            imageBuffer = fs.readFileSync(resolvedNativePath);
            const extension = path.extname(resolvedNativePath).toLowerCase();
            if (extension === ".png") {
                contentType = "image/png";
            } else if (extension === ".webp") {
                contentType = "image/webp";
            }
        } else {
            if (!isPublicCoverArtUrl(coverUrl)) {
                sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Cover art not found",
                    format,
                    callback,
                );
                return;
            }

            const fetched = await fetchCoverArtBuffer(coverUrl);
            imageBuffer = fetched.buffer;
            contentType = fetched.contentType;
        }

        const resized = await maybeResizeCoverArt(
            imageBuffer,
            contentType,
            requestedSize,
        );

        res.setHeader("Content-Type", resized.contentType);
        res.setHeader("Cache-Control", SUBSONIC_COVER_CACHE_CONTROL);
        res.setHeader("Accept-Ranges", "bytes");
        res.status(200).send(resized.buffer);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "";
        if (errorMessage === "COVER_FETCH_FAILED:404") {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Cover art not found",
                format,
                callback,
            );
            return;
        }

        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch cover art",
            format,
            callback,
        );
    }
}

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

async function ensureLibraryTracksExist(trackIds: string[]): Promise<boolean> {
    if (trackIds.length === 0) {
        return true;
    }

    const tracks = await prisma.track.findMany({
        where: {
            id: {
                in: trackIds,
            },
            album: {
                location: LIBRARY_LOCATION,
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
            location: LIBRARY_LOCATION,
        },
        select: {
            id: true,
        },
    });

    return albums.length === albumIds.length;
}

async function ensureLibraryArtistsExist(artistIds: string[]): Promise<boolean> {
    if (artistIds.length === 0) {
        return true;
    }

    const artists = await prisma.artist.findMany({
        where: {
            id: {
                in: artistIds,
            },
            albums: {
                some: {
                    location: LIBRARY_LOCATION,
                },
            },
        },
        select: {
            id: true,
        },
    });

    return artists.length === artistIds.length;
}

async function resolveStarMutationTrackIds(input: {
    songTrackIds: string[];
    albumIds: string[];
    artistIds: string[];
}): Promise<string[]> {
    const { songTrackIds, albumIds, artistIds } = input;
    const combinedIds = new Set<string>(songTrackIds);

    if (albumIds.length > 0) {
        const albumTracks = await prisma.track.findMany({
            where: {
                albumId: {
                    in: albumIds,
                },
                album: {
                    location: LIBRARY_LOCATION,
                },
            },
            select: {
                id: true,
            },
        });

        for (const track of albumTracks) {
            combinedIds.add(track.id);
        }
    }

    if (artistIds.length > 0) {
        const artistTracks = await prisma.track.findMany({
            where: {
                album: {
                    location: LIBRARY_LOCATION,
                    artistId: {
                        in: artistIds,
                    },
                },
            },
            select: {
                id: true,
            },
        });

        for (const track of artistTracks) {
            combinedIds.add(track.id);
        }
    }

    return Array.from(combinedIds);
}

export async function handleGetPlaylists(req: Request, res: Response): Promise<void> {
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
                        items: true,
                    },
                },
                items: {
                    orderBy: {
                        sort: "asc",
                    },
                    select: {
                        track: {
                            select: {
                                duration: true,
                                album: {
                                    select: {
                                        coverUrl: true,
                                        genres: true,
                                        userGenres: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        sendSubsonicSuccess(
            res,
            {
                playlists: {
                    playlist: playlists.map((playlist) => {
                        const duration = playlist.items.reduce(
                            (sum, item) => sum + (item.track?.duration ?? 0),
                            0,
                        );
                        const hasCover = playlist.items.some((item) =>
                            Boolean(item.track?.album.coverUrl),
                        );
                        return {
                            id: toSubsonicId("playlist", playlist.id),
                            name: playlist.name,
                            songCount: playlist._count.items,
                            duration,
                            public: playlist.isPublic,
                            owner: req.user!.username,
                            created: playlist.createdAt.toISOString(),
                            changed: playlist.createdAt.toISOString(),
                            coverArt: hasCover
                                ? toSubsonicId("playlist", playlist.id)
                                : undefined,
                        };
                    }),
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

export async function handleGetPlaylist(req: Request, res: Response): Promise<void> {
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

export async function handleCreatePlaylist(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawPlaylistId =
        typeof req.query.playlistId === "string" ? req.query.playlistId : "";
    const rawName = typeof req.query.name === "string" ? req.query.name.trim() : "";
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

export async function handleUpdatePlaylist(req: Request, res: Response): Promise<void> {
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

    const rawName = typeof req.query.name === "string" ? req.query.name.trim() : "";
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
                        .filter((value) => Number.isInteger(value) && value >= 0),
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

            const existingTrackIds = new Set(existingItems.map((item) => item.trackId));
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

export async function handleDeletePlaylist(req: Request, res: Response): Promise<void> {
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

export async function handleScrobble(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawIds = getQueryValues(req.query.id);
    if (rawIds.length === 0) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            callback,
        );
        return;
    }

    const rawSubmissionValues = getQueryValues(req.query.submission);
    const rawTimes = getQueryValues(req.query.time);

    let parsedTrackIds: string[] = [];
    try {
        parsedTrackIds = rawIds.map((rawId) => parseSubsonicId(rawId, "track").id);
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
        const uniqueTrackIds = Array.from(new Set(parsedTrackIds));
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

        const playRows = parsedTrackIds.flatMap((trackId, index) => {
            const submissionValue =
                rawSubmissionValues.length > 0
                    ? rawSubmissionValues[Math.min(index, rawSubmissionValues.length - 1)]
                    : undefined;
            const shouldSubmit = submissionValue
                ? !["false", "0"].includes(submissionValue.toLowerCase())
                : true;

            if (!shouldSubmit) {
                return [];
            }

            const rawTime =
                rawTimes.length > 0
                    ? rawTimes[Math.min(index, rawTimes.length - 1)]
                    : undefined;
            const parsedTime = rawTime ? Number.parseInt(rawTime, 10) : Number.NaN;
            const playedAt =
                Number.isFinite(parsedTime) && parsedTime > 0
                    ? new Date(parsedTime * 1000)
                    : new Date();

            return [
                {
                    userId: req.user!.id,
                    trackId,
                    playedAt,
                },
            ];
        });

        if (playRows.length > 0) {
            await prisma.play.createMany({
                data: playRows,
            });
        }

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to scrobble",
            format,
            callback,
        );
    }
}

export async function handleGetNowPlaying(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);

    try {
        const cutoff = new Date(Date.now() - 10 * 60 * 1000);
        const playbackStates = await prisma.playbackState.findMany({
            where: {
                userId: req.user!.id,
                trackId: {
                    not: null,
                },
                updatedAt: {
                    gte: cutoff,
                },
            },
            orderBy: {
                updatedAt: "desc",
            },
            take: 20,
        });

        const trackIds = Array.from(
            new Set(
                playbackStates
                    .map((state) => state.trackId)
                    .filter((trackId): trackId is string => Boolean(trackId)),
            ),
        );

        if (trackIds.length === 0) {
            sendSubsonicSuccess(
                res,
                {
                    nowPlaying: {
                        entry: [],
                    },
                },
                format,
                callback,
            );
            return;
        }

        const tracks = await prisma.track.findMany({
            where: {
                id: {
                    in: trackIds,
                },
                album: {
                    location: LIBRARY_LOCATION,
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
        const trackById = new Map(tracks.map((track) => [track.id, track]));

        const entries = playbackStates
            .map((state) => {
                const trackId = state.trackId;
                if (!trackId) {
                    return null;
                }

                const track = trackById.get(trackId);
                if (!track) {
                    return null;
                }

                return {
                    ...formatSongForSubsonic(track),
                    username: req.user!.username,
                    playerId: state.deviceId,
                    minutesAgo: Math.max(
                        0,
                        Math.floor((Date.now() - state.updatedAt.getTime()) / 60000),
                    ),
                };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        sendSubsonicSuccess(
            res,
            {
                nowPlaying: {
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
            "Failed to fetch now playing",
            format,
            callback,
        );
    }
}

export async function handleGetUser(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const requestedUsername =
        typeof req.query.username === "string" && req.query.username.trim().length > 0
            ? req.query.username.trim()
            : req.user!.username;

    if (requestedUsername !== req.user!.username && req.user!.role !== "admin") {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_AUTHORIZED,
            "Not authorized",
            format,
            callback,
        );
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { username: requestedUsername },
            select: {
                username: true,
                role: true,
            },
        });

        if (!user) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "User not found",
                format,
                callback,
            );
            return;
        }

        sendSubsonicSuccess(
            res,
            {
                user: {
                    username: user.username,
                    email: `${user.username}@${BRAND_SLUG}.local`,
                    scrobblingEnabled: true,
                    adminRole: user.role === "admin",
                    settingsRole: true,
                    downloadRole: true,
                    uploadRole: false,
                    playlistRole: true,
                    coverArtRole: true,
                    commentRole: false,
                    podcastRole: false,
                    streamRole: true,
                    jukeboxRole: false,
                    shareRole: false,
                    videoConversionRole: true,
                },
            },
            format,
            callback,
        );
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch user",
            format,
            callback,
        );
    }
}

export async function handleGetAvatar(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const requestedUsername =
        typeof req.query.username === "string" && req.query.username.trim().length > 0
            ? req.query.username.trim()
            : req.user!.username;

    if (requestedUsername !== req.user!.username && req.user!.role !== "admin") {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_AUTHORIZED,
            "Not authorized",
            format,
            callback,
        );
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: {
                username: requestedUsername,
            },
            select: {
                username: true,
            },
        });

        if (!user) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "User not found",
                format,
                callback,
            );
            return;
        }

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", SUBSONIC_COVER_CACHE_CONTROL);
        res.status(200).send(DEFAULT_SUBSONIC_AVATAR_PNG);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch avatar",
            format,
            callback,
        );
    }
}

export async function handleSetRating(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const rawRating = getRequiredQueryString(req, res, "rating", format, callback);
    if (!rawRating) {
        return;
    }

    const rating = Number.parseInt(rawRating, 10);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'rating' is invalid",
            format,
            callback,
        );
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
        const trackExists = await ensureLibraryTracksExist([trackId]);
        if (!trackExists) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                callback,
            );
            return;
        }

        if (rating === 0) {
            await prisma.likedTrack.deleteMany({
                where: {
                    userId: req.user!.id,
                    trackId,
                },
            });
        } else {
            await prisma.likedTrack.createMany({
                data: [
                    {
                        userId: req.user!.id,
                        trackId,
                    },
                ],
                skipDuplicates: true,
            });
        }

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to set rating",
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
                album: {
                    location: LIBRARY_LOCATION,
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
    });

    const songs = likedTracks.map((likedTrack) => ({
        ...formatSongForSubsonic(likedTrack.track),
        starred: likedTrack.likedAt.toISOString(),
    }));

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

    const [albums, artists] = await Promise.all([
        albumStarredAt.size > 0
            ? prisma.album.findMany({
                where: {
                    id: {
                        in: Array.from(albumStarredAt.keys()),
                    },
                    location: LIBRARY_LOCATION,
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
                        select: {
                            duration: true,
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
                        some: {
                            location: LIBRARY_LOCATION,
                        },
                    },
                },
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    albums: {
                        where: {
                            location: LIBRARY_LOCATION,
                        },
                        select: {
                            id: true,
                        },
                    },
                },
            })
            : Promise.resolve([]),
    ]);

    const albumEntries = albums
        .map((album) => ({
            ...formatAlbumForSubsonic({
                id: album.id,
                title: album.title,
                year: album.year,
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
            starred: albumStarredAt.get(album.id)?.toISOString(),
        }))
        .sort((left, right) =>
            String(right.starred ?? "").localeCompare(String(left.starred ?? "")),
        );

    const artistEntries = artists
        .map((artist) => ({
            ...formatArtistForSubsonic({
                id: artist.id,
                name: artist.name,
                albumCount: artist.albums.length,
                heroUrl: artist.heroUrl,
            }),
            starred: artistStarredAt.get(artist.id)?.toISOString(),
        }))
        .sort((left, right) =>
            String(right.starred ?? "").localeCompare(String(left.starred ?? "")),
        );

    return {
        artist: artistEntries,
        album: albumEntries,
        song: songs,
    };
}

export async function handleGetStarred2(req: Request, res: Response): Promise<void> {
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

export async function handleGetStarred(req: Request, res: Response): Promise<void> {
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

export async function handleStar(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawSongIds = getQueryValues(req.query.id);
    const rawAlbumIds = getQueryValues(req.query.albumId);
    const rawArtistIds = getQueryValues(req.query.artistId);

    if (rawSongIds.length === 0 && rawAlbumIds.length === 0 && rawArtistIds.length === 0) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id', 'albumId', or 'artistId' is missing",
            format,
            callback,
        );
        return;
    }

    let songTrackIds: string[] = [];
    let albumIds: string[] = [];
    let artistIds: string[] = [];

    try {
        songTrackIds = parseTrackIdsFromQueryValues(rawSongIds);
        albumIds = parseEntityIdsFromQueryValues(rawAlbumIds, "album");
        artistIds = parseEntityIdsFromQueryValues(rawArtistIds, "artist");
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Invalid song, album, or artist ID",
            format,
            callback,
        );
        return;
    }

    try {
        const [tracksExist, albumsExist, artistsExist] = await Promise.all([
            ensureLibraryTracksExist(songTrackIds),
            ensureLibraryAlbumsExist(albumIds),
            ensureLibraryArtistsExist(artistIds),
        ]);

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

        if (!albumsExist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Album not found",
                format,
                callback,
            );
            return;
        }

        if (!artistsExist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Artist not found",
                format,
                callback,
            );
            return;
        }

        const trackIds = await resolveStarMutationTrackIds({
            songTrackIds,
            albumIds,
            artistIds,
        });

        if (trackIds.length === 0) {
            sendSubsonicSuccess(res, {}, format, callback);
            return;
        }

        await prisma.likedTrack.createMany({
            data: trackIds.map((trackId) => ({
                userId: req.user!.id,
                trackId,
            })),
            skipDuplicates: true,
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to star item",
            format,
            callback,
        );
    }
}

export async function handleUnstar(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawSongIds = getQueryValues(req.query.id);
    const rawAlbumIds = getQueryValues(req.query.albumId);
    const rawArtistIds = getQueryValues(req.query.artistId);

    if (rawSongIds.length === 0 && rawAlbumIds.length === 0 && rawArtistIds.length === 0) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id', 'albumId', or 'artistId' is missing",
            format,
            callback,
        );
        return;
    }

    let songTrackIds: string[] = [];
    let albumIds: string[] = [];
    let artistIds: string[] = [];

    try {
        songTrackIds = parseTrackIdsFromQueryValues(rawSongIds);
        albumIds = parseEntityIdsFromQueryValues(rawAlbumIds, "album");
        artistIds = parseEntityIdsFromQueryValues(rawArtistIds, "artist");
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_FOUND,
            "Invalid song, album, or artist ID",
            format,
            callback,
        );
        return;
    }

    try {
        const [tracksExist, albumsExist, artistsExist] = await Promise.all([
            ensureLibraryTracksExist(songTrackIds),
            ensureLibraryAlbumsExist(albumIds),
            ensureLibraryArtistsExist(artistIds),
        ]);

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

        if (!albumsExist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Album not found",
                format,
                callback,
            );
            return;
        }

        if (!artistsExist) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Artist not found",
                format,
                callback,
            );
            return;
        }

        const trackIds = await resolveStarMutationTrackIds({
            songTrackIds,
            albumIds,
            artistIds,
        });

        if (trackIds.length === 0) {
            sendSubsonicSuccess(res, {}, format, callback);
            return;
        }

        await prisma.likedTrack.deleteMany({
            where: {
                userId: req.user!.id,
                trackId: {
                    in: trackIds,
                },
            },
        });

        sendSubsonicSuccess(res, {}, format, callback);
    } catch {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to unstar item",
            format,
            callback,
        );
    }
}

function endpointAliases(endpoint: string): string[] {
    return [
        `/${endpoint}`,
        `/${endpoint}.view`,
        `/rest/${endpoint}`,
        `/rest/${endpoint}.view`,
    ];
}

router.get(endpointAliases("ping"), handlePing);
router.post(endpointAliases("ping"), handlePing);
router.get(endpointAliases("getLicense"), handleGetLicense);
router.get(
    endpointAliases("getOpenSubsonicExtensions"),
    handleGetOpenSubsonicExtensions,
);
router.get(endpointAliases("tokenInfo"), handleTokenInfo);
router.get(endpointAliases("getMusicFolders"), handleGetMusicFolders);
router.get(endpointAliases("getMusicDirectory"), handleGetMusicDirectory);
router.get(endpointAliases("getIndexes"), handleGetIndexes);
router.get(endpointAliases("getArtists"), handleGetArtists);
router.get(endpointAliases("getArtist"), handleGetArtist);
router.get(endpointAliases("getArtistInfo2"), handleGetArtistInfo2);
router.get(endpointAliases("getAlbum"), handleGetAlbum);
router.get(endpointAliases("getAlbumInfo2"), handleGetAlbumInfo2);
router.get(endpointAliases("getSong"), handleGetSong);
router.get(endpointAliases("getTopSongs"), handleGetTopSongs);
router.get(endpointAliases("getSimilarSongs"), handleGetSimilarSongs);
router.get(endpointAliases("getSimilarSongs2"), handleGetSimilarSongs2);
router.get(endpointAliases("getAlbumList"), handleGetAlbumList);
router.get(endpointAliases("getAlbumList2"), handleGetAlbumList2);
router.get(endpointAliases("getGenres"), handleGetGenres);
router.get(endpointAliases("getSongsByGenre"), handleGetSongsByGenre);
router.get(endpointAliases("getRandomSongs"), handleGetRandomSongs);
router.get(endpointAliases("stream"), handleStream);
router.get(endpointAliases("download"), handleDownload);
router.get(endpointAliases("getCoverArt"), handleGetCoverArt);
router.get(endpointAliases("getLyrics"), handleGetLyrics);
router.get(endpointAliases("getLyricsBySongId"), handleGetLyricsBySongId);
router.get(endpointAliases("search"), handleSearch);
router.get(endpointAliases("search2"), handleSearch2);
router.get(endpointAliases("search3"), handleSearch3);
router.get(endpointAliases("getPlaylists"), handleGetPlaylists);
router.get(endpointAliases("getPlaylist"), handleGetPlaylist);
router.get(endpointAliases("getPlayQueue"), handleGetPlayQueue);
router.post(endpointAliases("savePlayQueue"), handleSavePlayQueue);
router.get(endpointAliases("savePlayQueue"), handleSavePlayQueue);
router.get(endpointAliases("getPlayQueueByIndex"), handleGetPlayQueueByIndex);
router.post(endpointAliases("savePlayQueueByIndex"), handleSavePlayQueueByIndex);
router.get(endpointAliases("savePlayQueueByIndex"), handleSavePlayQueueByIndex);
router.get(endpointAliases("getBookmarks"), handleGetBookmarks);
router.get(endpointAliases("createBookmark"), handleCreateBookmark);
router.post(endpointAliases("createBookmark"), handleCreateBookmark);
router.get(endpointAliases("deleteBookmark"), handleDeleteBookmark);
router.post(endpointAliases("deleteBookmark"), handleDeleteBookmark);
router.get(endpointAliases("setRating"), handleSetRating);
router.post(endpointAliases("setRating"), handleSetRating);
router.get(endpointAliases("createPlaylist"), handleCreatePlaylist);
router.post(endpointAliases("createPlaylist"), handleCreatePlaylist);
router.get(endpointAliases("updatePlaylist"), handleUpdatePlaylist);
router.post(endpointAliases("updatePlaylist"), handleUpdatePlaylist);
router.get(endpointAliases("deletePlaylist"), handleDeletePlaylist);
router.post(endpointAliases("deletePlaylist"), handleDeletePlaylist);
router.get(endpointAliases("scrobble"), handleScrobble);
router.post(endpointAliases("scrobble"), handleScrobble);
router.get(endpointAliases("getNowPlaying"), handleGetNowPlaying);
router.get(endpointAliases("getUser"), handleGetUser);
router.get(endpointAliases("getAvatar"), handleGetAvatar);
router.get(endpointAliases("getStarred"), handleGetStarred);
router.get(endpointAliases("getStarred2"), handleGetStarred2);
router.get(endpointAliases("getScanStatus"), handleGetScanStatus);
router.get(endpointAliases("startScan"), handleStartScan);
router.post(endpointAliases("startScan"), handleStartScan);
router.get(endpointAliases("star"), handleStar);
router.post(endpointAliases("star"), handleStar);
router.get(endpointAliases("unstar"), handleUnstar);
router.post(endpointAliases("unstar"), handleUnstar);

router.all("*", (req, res) => {
    const { format, callback } = getRequestContext(req);
    sendSubsonicError(
        res,
        SubsonicErrorCode.NOT_FOUND,
        "Endpoint not supported",
        format,
        callback,
    );
});

export default router;
