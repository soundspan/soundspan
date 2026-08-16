import path from "path";
import fs from "fs";
import { type Request, type Response } from "express";
import {
    AudioStreamingService,
    type Quality,
} from "../../services/audioStreaming";
import {
    negotiateCoverArtFormat,
    resizeCoverArt,
    snapCoverArtSize,
} from "../../services/coverArtResize";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { getLyrics } from "../../services/lyrics";
import {
    resolveSubsonicStreamQuality,
    resolveTrackPathWithinRoot,
} from "../../utils/subsonicMedia";
import { logger } from "../../utils/logger";
import { proxyFederatedTrackStream } from "../../services/federationStreamProxy";
import { proxyFederatedCover } from "../../services/federationCoverProxy";
import {
    parseSubsonicId,
    type SubsonicEntityType,
} from "../../utils/subsonicIds";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
    type ResponseFormat,
} from "../../utils/subsonicResponse";
import {
    DEFAULT_SUBSONIC_AVATAR_PNG,
    fetchCoverArtBuffer,
    getRequestContext,
    getRequiredQueryString,
    LIBRARY_ALBUM_WHERE,
    LIBRARY_TRACK_WHERE,
    parseEntityIdOrNotFound,
    parseSyncedLyricsLines,
    PLAYLIST_TRACK_WHERE,
    resolveNativeCoverPath,
    SUBSONIC_ALBUM_LOCATION_WHERE,
    SUBSONIC_COVER_CACHE_CONTROL,
} from "./shared";

const log = logger.child("Subsonic");

async function resolveCoverArtUrl(
    type: SubsonicEntityType | undefined,
    entityId: string,
    userId: string,
): Promise<string | null> {
    if (type === "album") {
        const album = await prisma.album.findFirst({
            where: {
                id: entityId,
                ...LIBRARY_ALBUM_WHERE,
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
                    some: LIBRARY_ALBUM_WHERE,
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
                ...LIBRARY_TRACK_WHERE,
                id: entityId,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
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
                            ...LIBRARY_TRACK_WHERE,
                            album: {
                                location: SUBSONIC_ALBUM_LOCATION_WHERE,
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
                ...LIBRARY_ALBUM_WHERE,
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
                    some: LIBRARY_ALBUM_WHERE,
                },
            },
            select: {
                heroUrl: true,
            },
        }),
        prisma.track.findFirst({
            where: {
                ...LIBRARY_TRACK_WHERE,
                id: entityId,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
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
                            ...LIBRARY_TRACK_WHERE,
                            album: {
                                location: SUBSONIC_ALBUM_LOCATION_WHERE,
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

async function loadFederatedCoverTarget(
    type: SubsonicEntityType | undefined,
    entityId: string,
) {
    if (type === "track") {
        const track = await prisma.track.findFirst({
            where: { id: entityId, ...LIBRARY_TRACK_WHERE },
            select: {
                album: {
                    select: {
                        remoteId: true,
                        federationPeer: {
                            select: {
                                id: true,
                                baseUrl: true,
                                outboundToken: true,
                                outboundStatus: true,
                            },
                        },
                    },
                },
            },
        });
        return track?.album ?? null;
    }
    if (type !== "album" && type !== undefined) return null;
    return prisma.album.findFirst({
        where: { id: entityId, ...LIBRARY_ALBUM_WHERE },
        select: {
            remoteId: true,
            federationPeer: {
                select: {
                    id: true,
                    baseUrl: true,
                    outboundToken: true,
                    outboundStatus: true,
                },
            },
        },
    });
}

async function proxySubsonicFederatedCover(
    req: Request,
    res: Response,
    type: SubsonicEntityType | undefined,
    entityId: string,
): Promise<boolean> {
    const target = await loadFederatedCoverTarget(type, entityId);
    const peer = target?.federationPeer;
    if (
        !target?.remoteId ||
        !peer ||
        peer.outboundStatus !== "ACTIVE" ||
        !peer.baseUrl ||
        !peer.outboundToken
    ) {
        return false;
    }
    return proxyFederatedCover({
        req,
        res,
        peer,
        remoteId: target.remoteId,
    });
}

type SubsonicStreamTrack = {
    id: string;
    origin: "LOCAL" | "FEDERATED";
    remoteId: string | null;
    mime: string | null;
    filePath: string | null;
    fileModified: Date;
    federationPeer: {
        id: string;
        baseUrl: string | null;
        outboundToken: string | null;
        outboundStatus: string | null;
    } | null;
};

async function proxySubsonicFederatedStream(input: {
    req: Request;
    res: Response;
    track: SubsonicStreamTrack;
    quality: Quality;
    format: ResponseFormat;
    callback?: string;
}): Promise<boolean> {
    const { track, res } = input;
    if (track.origin !== "FEDERATED") return false;
    const peer = track.federationPeer;
    if (
        !track.remoteId ||
        !peer ||
        peer.outboundStatus !== "ACTIVE" ||
        !peer.baseUrl ||
        !peer.outboundToken
    ) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Federation peer is offline",
            input.format,
            input.callback,
        );
        return true;
    }
    try {
        await proxyFederatedTrackStream({
            req: input.req,
            res,
            peer,
            remoteId: track.remoteId,
            trackId: track.id,
            sourceModified: track.fileModified,
            sourceMime: track.mime,
            quality: input.quality,
        });
    } catch (error: unknown) {
        log.warn("Federated stream proxy failed", { error });
        if (!res.headersSent) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.GENERIC,
                "Federation peer is offline",
                input.format,
                input.callback,
            );
        } else if (!res.writableEnded) {
            res.end();
        }
    }
    return true;
}

/** Executes handleStream. */
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

    const quality = resolveSubsonicStreamQuality(
        req.query.maxBitRate,
        req.query.format,
    );

    let streamingService: AudioStreamingService | null = null;

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
                origin: true,
                remoteId: true,
                mime: true,
                filePath: true,
                fileModified: true,
                federationPeer: {
                    select: {
                        id: true,
                        baseUrl: true,
                        outboundToken: true,
                        outboundStatus: true,
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

        if (
            await proxySubsonicFederatedStream({
                req,
                res,
                track,
                quality,
                format,
                callback,
            })
        ) {
            return;
        }

        if (!track.filePath || !track.fileModified) {
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

/**
 * Executes handleDownload.
 */
export async function handleDownload(
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
                origin: true,
                remoteId: true,
                mime: true,
                filePath: true,
                fileModified: true,
                federationPeer: {
                    select: {
                        id: true,
                        baseUrl: true,
                        outboundToken: true,
                        outboundStatus: true,
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

        if (
            await proxySubsonicFederatedStream({
                req,
                res,
                track,
                quality: "original",
                format,
                callback,
            })
        ) {
            return;
        }

        if (!track.filePath) {
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

/**
 * Executes handleGetLyrics.
 */
export async function handleGetLyrics(
    req: Request,
    res: Response,
): Promise<void> {
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
                ...LIBRARY_TRACK_WHERE,
                title: rawTitle
                    ? {
                          contains: rawTitle,
                          mode: "insensitive",
                      }
                    : undefined,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
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

/**
 * Executes handleGetLyricsBySongId.
 */
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
                ...LIBRARY_TRACK_WHERE,
                id: trackId,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
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

/**
 * Executes handleGetCoverArt.
 */
export async function handleGetCoverArt(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const requestedSize = snapCoverArtSize(req.query.size);

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
            if (await proxySubsonicFederatedCover(req, res, type, entityId)) {
                return;
            }
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
            const fetched = await fetchCoverArtBuffer(coverUrl);
            imageBuffer = fetched.buffer;
            contentType = fetched.contentType;
        }

        const imageFormat = negotiateCoverArtFormat(req.headers.accept);
        const resized = await resizeCoverArt({
            buffer: imageBuffer,
            contentType,
            size: requestedSize,
            format: imageFormat,
        });

        res.setHeader("Content-Type", resized.contentType ?? contentType);
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
/**
 * Executes handleGetAvatar.
 */
export async function handleGetAvatar(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const requestedUsername =
        typeof req.query.username === "string" &&
        req.query.username.trim().length > 0
            ? req.query.username.trim()
            : req.user!.username;

    if (
        requestedUsername !== req.user!.username &&
        req.user!.role !== "admin"
    ) {
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
