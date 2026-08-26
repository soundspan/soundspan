import { type Request, type Response } from "express";
import { prisma } from "../../utils/db";
import { parseSubsonicId } from "../../utils/subsonicIds";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    ensureLibraryAlbumsExist,
    ensureLibraryArtistsExist,
    ensureLibraryTracksExist,
    getQueryValues,
    getRequestContext,
    getRequiredQueryString,
    LIBRARY_TRACK_WHERE,
    parseEntityIdOrNotFound,
    parseEntityIdsFromQueryValues,
    parseTrackIdsFromQueryValues,
    SUBSONIC_ALBUM_LOCATION_WHERE,
} from "./shared";
import { setSongUserRating } from "./songEnrichment";
import {
    mapSubsonicScrobbleEvents,
    type SubsonicScrobbleEvent,
} from "./scrobbleMapping";
import { forwardTrackReferenceIsolated } from "../../services/scrobbleForwarder";

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
                ...LIBRARY_TRACK_WHERE,
                albumId: {
                    in: albumIds,
                },
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
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
                ...LIBRARY_TRACK_WHERE,
                album: {
                    location: SUBSONIC_ALBUM_LOCATION_WHERE,
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

function mapScrobbleRequest(
    req: Request,
    trackIds: string[],
): SubsonicScrobbleEvent[] {
    return mapSubsonicScrobbleEvents(
        trackIds,
        getQueryValues(req.query.submission),
        getQueryValues(req.query.time),
        new Date(),
    );
}

function parseScrobbleTrackIds(rawIds: string[]): string[] | null {
    try {
        return rawIds.map((rawId) => parseSubsonicId(rawId, "track").id);
    } catch {
        return null;
    }
}

async function recordScrobblePlays(
    userId: string,
    events: SubsonicScrobbleEvent[],
): Promise<void> {
    const data = events
        .filter((event) => event.kind === "scrobble")
        .map((event) => ({
            userId,
            trackId: event.trackId,
            playedAt: event.listenedAt,
        }));
    if (data.length > 0) {
        await prisma.play.createMany({ data });
    }
}

function forwardSubsonicScrobbles(
    userId: string,
    events: SubsonicScrobbleEvent[],
): void {
    for (const event of events) {
        forwardTrackReferenceIsolated({
            userId,
            mediaType: "music",
            kind: event.kind,
            listenedAt: event.listenedAt,
            reference: { source: "local", id: event.trackId },
        });
    }
}

/**
 * Executes handleScrobble.
 */
export async function handleScrobble(
    req: Request,
    res: Response,
): Promise<void> {
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

    const parsedTrackIds = parseScrobbleTrackIds(rawIds);
    if (!parsedTrackIds) {
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

        const events = mapScrobbleRequest(req, parsedTrackIds);
        await recordScrobblePlays(req.user!.id, events);
        forwardSubsonicScrobbles(req.user!.id, events);

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
/**
 * Executes handleSetRating.
 */
export async function handleSetRating(
    req: Request,
    res: Response,
): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawId = getRequiredQueryString(req, res, "id", format, callback);
    if (!rawId) {
        return;
    }

    const rawRating = getRequiredQueryString(
        req,
        res,
        "rating",
        format,
        callback,
    );
    if (!rawRating) {
        return;
    }

    if (!/^[0-5]$/.test(rawRating)) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'rating' is invalid",
            format,
            callback,
        );
        return;
    }
    const rating = Number(rawRating);

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

        await setSongUserRating(req.user!.id, trackId, rating);

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
/**
 * Executes handleStar.
 */
export async function handleStar(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawSongIds = getQueryValues(req.query.id);
    const rawAlbumIds = getQueryValues(req.query.albumId);
    const rawArtistIds = getQueryValues(req.query.artistId);

    if (
        rawSongIds.length === 0 &&
        rawAlbumIds.length === 0 &&
        rawArtistIds.length === 0
    ) {
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

/**
 * Executes handleUnstar.
 */
export async function handleUnstar(req: Request, res: Response): Promise<void> {
    const { format, callback } = getRequestContext(req);
    const rawSongIds = getQueryValues(req.query.id);
    const rawAlbumIds = getQueryValues(req.query.albumId);
    const rawArtistIds = getQueryValues(req.query.artistId);

    if (
        rawSongIds.length === 0 &&
        rawAlbumIds.length === 0 &&
        rawArtistIds.length === 0
    ) {
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
