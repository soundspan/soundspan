import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import {
    normalizeTidalTrack,
    normalizeYtMusicTrack,
    type UnifiedTrackResponse,
} from "./unifiedTrackResponse";

export type RemoteOwnedTrackSort = "asc" | "desc";

interface LoadRemoteOwnedTracksOptions {
    query?: string;
    take?: number;
    sort?: RemoteOwnedTrackSort;
    match?: "any" | "title";
}

function buildTidalWhere(
    userId: string,
    query: string,
    match: "any" | "title",
): Prisma.TrackTidalWhereInput {
    const where: Prisma.TrackTidalWhereInput = {
        likedBy: { some: { userId } },
    };

    if (!query) {
        return where;
    }

    if (match === "title") {
        where.title = {
            contains: query,
            mode: "insensitive",
        };
        return where;
    }

    where.OR = [
        { title: { contains: query, mode: "insensitive" } },
        { artist: { contains: query, mode: "insensitive" } },
        { album: { contains: query, mode: "insensitive" } },
    ];
    return where;
}

function buildYtMusicWhere(
    userId: string,
    query: string,
    match: "any" | "title",
): Prisma.TrackYtMusicWhereInput {
    const where: Prisma.TrackYtMusicWhereInput = {
        likedBy: { some: { userId } },
    };

    if (!query) {
        return where;
    }

    if (match === "title") {
        where.title = {
            contains: query,
            mode: "insensitive",
        };
        return where;
    }

    where.OR = [
        { title: { contains: query, mode: "insensitive" } },
        { artist: { contains: query, mode: "insensitive" } },
        { album: { contains: query, mode: "insensitive" } },
    ];
    return where;
}

/**
 * Artist ownership predicates for provider tracks liked by one user.
 *
 * These deliberately key off LikedRemoteTrack rather than the global
 * remoteTrackCount so one user's provider library never grants ownership
 * to another user.
 */
export function buildRemoteOwnedArtistFilters(
    userId: string,
): Prisma.ArtistWhereInput[] {
    return [
        {
            tracksTidal: {
                some: {
                    likedBy: {
                        some: { userId },
                    },
                },
            },
        },
        {
            tracksYtMusic: {
                some: {
                    likedBy: {
                        some: { userId },
                    },
                },
            },
        },
    ];
}

export function addRemoteOwnedArtists(
    where: Prisma.ArtistWhereInput,
    userId: string | undefined,
    origin: "all" | "local" | "peers",
    filter: unknown,
): void {
    if (filter !== "owned" || origin !== "all" || !userId) {
        return;
    }

    const existing = Array.isArray(where.OR)
        ? where.OR
        : where.OR
          ? [where.OR]
          : [];

    where.OR = [...existing, ...buildRemoteOwnedArtistFilters(userId)];
}

/**
 * Load the authenticated user's liked provider tracks and normalize them
 * through the same canonical identities used by playback and My Liked.
 */
export async function loadRemoteOwnedTracksForUser(
    userId: string,
    options: LoadRemoteOwnedTracksOptions = {},
): Promise<UnifiedTrackResponse[]> {
    const query = (options.query ?? "").trim();
    const take = Math.max(1, options.take ?? 100);
    const sort = options.sort ?? "asc";
    const match = options.match ?? "any";

    const [tidalTracks, ytMusicTracks] = await Promise.all([
        prisma.trackTidal.findMany({
            where: buildTidalWhere(userId, query, match),
            orderBy: { title: sort },
            take,
        }),
        prisma.trackYtMusic.findMany({
            where: buildYtMusicWhere(userId, query, match),
            orderBy: { title: sort },
            take,
        }),
    ]);

    const tracks = [
        ...tidalTracks.map(normalizeTidalTrack),
        ...ytMusicTracks.map(normalizeYtMusicTrack),
    ];

    tracks.sort((left, right) =>
        sort === "desc"
            ? right.title.localeCompare(left.title)
            : left.title.localeCompare(right.title),
    );

    return tracks.slice(0, take);
}

export async function countRemoteOwnedTracksForUser(
    userId: string,
): Promise<number> {
    const [tidalCount, ytMusicCount] = await Promise.all([
        prisma.trackTidal.count({
            where: { likedBy: { some: { userId } } },
        }),
        prisma.trackYtMusic.count({
            where: { likedBy: { some: { userId } } },
        }),
    ]);

    return tidalCount + ytMusicCount;
}

/**
 * Adapt a normalized provider track to the legacy-compatible Library/Search
 * response shape expected by existing frontend consumers.
 */
export function toLibraryRemoteTrack(track: UnifiedTrackResponse) {
    return {
        ...track,
        albumId: track.album.id,
        artistId: track.artist.id,
        trackNumber: track.trackNo,
        streamSource: track.source,
        ...(track.provider.tidalTrackId !== null
            ? { tidalTrackId: track.provider.tidalTrackId }
            : {}),
        ...(track.provider.youtubeVideoId !== null
            ? { youtubeVideoId: track.provider.youtubeVideoId }
            : {}),
        album: {
            ...track.album,
            artistId: track.artist.id,
            coverUrl: track.album.coverArt,
            artist: track.artist,
        },
    };
}
