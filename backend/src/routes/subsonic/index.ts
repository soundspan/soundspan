import { Router } from "express";
import { mergeSubsonicBodyParamsIntoQuery } from "../../middleware/subsonicRequestParams";
import { config } from "../../config";
import {
    requireSubsonicAuth,
    subsonicRateLimiter,
} from "../../middleware/subsonicAuth";
import { logger } from "../../utils/logger";
import {
    sendSubsonicError,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    handleGetOpenSubsonicExtensions,
    handleGetPodcasts,
    handleGetNewestPodcasts,
    handleGetLicense,
    handleGetScanStatus,
    handlePing,
    handleStartScan,
    handleTokenInfo,
} from "./system";
import {
    handleGetAlbum,
    handleGetAlbumInfo2,
    handleGetArtist,
    handleGetArtistInfo2,
    handleGetArtists,
    handleGetGenres,
    handleGetIndexes,
    handleGetMusicDirectory,
    handleGetMusicFolders,
    handleGetSong,
} from "./browsing";
import {
    handleGetSimilarSongs,
    handleGetSimilarSongs2,
    handleGetTopSongs,
} from "./discovery";
import {
    handleGetAlbumList,
    handleGetAlbumList2,
    handleGetRandomSongs,
    handleGetSongsByGenre,
    handleGetStarred,
    handleGetStarred2,
} from "./albumSongLists";
import { handleSearch, handleSearch2, handleSearch3 } from "./searching";
import {
    handleCreatePlaylist,
    handleDeletePlaylist,
    handleGetPlaylist,
    handleGetPlaylists,
    handleUpdatePlaylist,
} from "./playlists";
import {
    handleDownload,
    handleGetAvatar,
    handleGetCoverArt,
    handleGetLyrics,
    handleGetLyricsBySongId,
    handleStream,
} from "./mediaRetrieval";
import {
    handleScrobble,
    handleSetRating,
    handleStar,
    handleUnstar,
} from "./mediaAnnotation";
import {
    handleCreateBookmark,
    handleDeleteBookmark,
    handleGetBookmarks,
    handleGetPlayQueue,
    handleGetPlayQueueByIndex,
    handleSavePlayQueue,
    handleSavePlayQueueByIndex,
} from "./bookmarksQueue";
import { handleGetNowPlaying, handleGetUser } from "./usersMisc";
import { getRequestContext } from "./shared";

const router = Router();
const SUBSONIC_TRACE_LOGS = config.subsonicTraceLogs;
const subsonicTraceLog = logger.child("SubsonicTrace");

function sanitizeTraceField(value: unknown, maxLength = 64): string {
    if (typeof value !== "string") return "-";
    const sanitized = value
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
        .slice(0, maxLength);
    return sanitized.trim().length > 0 ? sanitized : "-";
}

router.use(mergeSubsonicBodyParamsIntoQuery);

if (SUBSONIC_TRACE_LOGS) {
    router.use((req, res, next) => {
        const startMs = Date.now();
        const method = req.method;
        const endpoint = sanitizeTraceField(
            req.path.startsWith("/") ? req.path.slice(1) : req.path,
            128,
        );
        const client = sanitizeTraceField(req.query.c);
        const version = sanitizeTraceField(req.query.v);
        const format = sanitizeTraceField(req.query.f ?? req.query.format);

        res.on("finish", () => {
            const protocolStatus =
                typeof res.locals?.subsonicProtocolStatus === "string"
                    ? res.locals.subsonicProtocolStatus
                    : "unknown";
            const errorCode =
                typeof res.locals?.subsonicErrorCode === "number"
                    ? res.locals.subsonicErrorCode
                    : null;

            subsonicTraceLog.warn("Subsonic request completed", {
                method,
                endpoint,
                client,
                version,
                format,
                httpStatus: res.statusCode,
                protocolStatus,
                errorCode,
                durationMs: Date.now() - startMs,
            });
        });

        next();
    });
}

router.use(subsonicRateLimiter);
router.use(requireSubsonicAuth);

const SUBSONIC_FORM_POST_READ_ENDPOINTS = new Set([
    "getLicense",
    "getPodcasts",
    "getNewestPodcasts",
    "getOpenSubsonicExtensions",
    "tokenInfo",
    "getMusicFolders",
    "getMusicDirectory",
    "getIndexes",
    "getArtists",
    "getArtist",
    "getArtistInfo2",
    "getAlbum",
    "getAlbumInfo2",
    "getSong",
    "getTopSongs",
    "getSimilarSongs",
    "getSimilarSongs2",
    "getAlbumList",
    "getAlbumList2",
    "getGenres",
    "getSongsByGenre",
    "getRandomSongs",
    "stream",
    "download",
    "getCoverArt",
    "getLyrics",
    "getLyricsBySongId",
    "search",
    "search2",
    "search3",
    "getPlaylists",
    "getPlaylist",
    "getPlayQueue",
    "getPlayQueueByIndex",
    "getBookmarks",
    "getNowPlaying",
    "getUser",
    "getAvatar",
    "getStarred",
    "getStarred2",
    "getScanStatus",
]);

// Clients such as Music Assistant send form-encoded POST requests for read
// endpoints. Reuse the existing GET handlers after authentication, but only
// for an explicit read-only allowlist so unknown or mutating POST endpoints
// retain their normal routing semantics.
router.use((req, _res, next) => {
    const endpoint = req.path
        .replace(/^\/(?:rest\/)?/, "")
        .replace(/\.view$/, "");
    if (
        req.method === "POST" &&
        SUBSONIC_FORM_POST_READ_ENDPOINTS.has(endpoint)
    ) {
        req.method = "GET";
    }
    next();
});

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
router.get(endpointAliases("getPodcasts"), handleGetPodcasts);
router.get(endpointAliases("getNewestPodcasts"), handleGetNewestPodcasts);
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
router.post(
    endpointAliases("savePlayQueueByIndex"),
    handleSavePlayQueueByIndex,
);
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
// Express 5 (path-to-regexp v8) requires named wildcards; "/{*splat}" keeps
// the Express 4 "*" behavior of also matching the router root path.
router.all("/{*splat}", (req, res) => {
    const { format, callback } = getRequestContext(req);
    sendSubsonicError(
        res,
        SubsonicErrorCode.NOT_FOUND,
        "Endpoint not supported",
        format,
        callback,
    );
});

export * from "./system";
export * from "./browsing";
export * from "./discovery";
export * from "./albumSongLists";
export * from "./searching";
export * from "./playlists";
export * from "./mediaRetrieval";
export * from "./mediaAnnotation";
export * from "./bookmarksQueue";
export * from "./usersMisc";

export default router;
