import { type Request, type Response } from "express";
import { BRAND_SLUG } from "../../config/brand";
import { prisma } from "../../utils/db";
import {
    sendSubsonicError,
    sendSubsonicSuccess,
    SubsonicErrorCode,
} from "../../utils/subsonicResponse";
import {
    formatSongForSubsonic,
    getRequestContext,
    LIBRARY_TRACK_WHERE,
    SUBSONIC_ALBUM_LOCATION_WHERE,
} from "./shared";

/**
 * Executes handleGetNowPlaying.
 */
export async function handleGetNowPlaying(
    req: Request,
    res: Response,
): Promise<void> {
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
                        Math.floor(
                            (Date.now() - state.updatedAt.getTime()) / 60000,
                        ),
                    ),
                };
            })
            .filter(
                (entry): entry is NonNullable<typeof entry> => entry !== null,
            );

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

/**
 * Executes handleGetUser.
 */
export async function handleGetUser(
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
