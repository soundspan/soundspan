import type { Prisma } from "@prisma/client";
import { allocateTracksWithArtistWeighting } from "./artistSlotAllocation";
import { buildTrackPreferenceScoreMapForUser } from "./libraryTrackPreferences";
import { applyTrackPreferenceOrderBias } from "./trackPreference";
import { config } from "../config";
import { prisma } from "../utils/db";
import { escapeLikePattern } from "../utils/likePattern";
import { logger } from "../utils/logger";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";
import { separateArtists } from "../utils/separateArtists";
import { shuffleArray } from "../utils/shuffle";
import {
    TRACK_BROWSE_SQL,
    VISIBLE_TRACK_SQL,
} from "../utils/libraryRadioPredicates";
import { transformRadioTrack } from "./libraryRadioTrackResponse";

const selectionLogger = logger.child("LibraryRadioStationSelection");
type RadioSelectionClient = Prisma.TransactionClient | typeof prisma;

export const LIBRARY_RADIO_PLAYLIST_TYPES = [
    "genre",
    "decade",
    "discovery",
    "favorites",
    "workout",
] as const;

export type LibraryRadioPlaylistType =
    (typeof LIBRARY_RADIO_PLAYLIST_TYPES)[number];

/** Returns true when a radio type is supported by generated station playlists. */
export function isLibraryRadioPlaylistType(
    value: string,
): value is LibraryRadioPlaylistType {
    return LIBRARY_RADIO_PLAYLIST_TYPES.some((type) => type === value);
}

export interface LibraryRadioStationSelectionInput {
    type: LibraryRadioPlaylistType;
    value?: string;
    limit: number;
    userId: string;
}

export interface LibraryRadioStationTrack {
    id: string;
    [key: string]: unknown;
}

export interface LibraryRadioStationSelection {
    tracks: LibraryRadioStationTrack[];
}

async function selectDiscoveryIds(
    client: RadioSelectionClient,
    limit: number,
): Promise<string[]> {
    const unplayed = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL} AND NOT EXISTS (
            SELECT 1 FROM "Play" p WHERE p."trackId" = t.id
        )
        ORDER BY random()
        LIMIT ${limit * 4}
    `;
    if (unplayed.length >= limit) return unplayed.map((track) => track.id);

    const leastPlayed = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM "Track" t
        LEFT JOIN "Play" p ON p."trackId" = t.id
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL}
        GROUP BY t.id
        ORDER BY COUNT(p.id) ASC
        LIMIT ${limit * 2}
    `;
    return leastPlayed.map((track) => track.id);
}

async function selectFavoritesIds(
    client: RadioSelectionClient,
    limit: number,
): Promise<string[]> {
    const mostPlayed = await client.$queryRaw<
        { id: string; play_count: bigint }[]
    >`
        SELECT t.id, COUNT(p.id) as play_count
        FROM "Track" t
        LEFT JOIN "Play" p ON p."trackId" = t.id
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL}
        GROUP BY t.id
        HAVING COUNT(p.id) > 0
        ORDER BY play_count DESC
        LIMIT ${limit * 2}
    `;
    if (mostPlayed.length > 0) return mostPlayed.map((track) => track.id);

    selectionLogger.debug("No favorites play data; using random tracks");
    const randomTracks = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL}
        ORDER BY random()
        LIMIT ${limit * 4}
    `;
    return randomTracks.map((track) => track.id);
}

async function selectDecadeIds(
    client: RadioSelectionClient,
    value: string | undefined,
    limit: number,
) {
    const decadeStart = Number.parseInt(value ?? "2000", 10) || 2000;
    const tracks = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL} AND (
            (a."originalYear" >= ${decadeStart} AND a."originalYear" < ${decadeStart + 10})
            OR (a."originalYear" IS NULL AND a."year" >= ${decadeStart} AND a."year" < ${decadeStart + 10})
        )
        ORDER BY random()
        LIMIT ${limit * 4}
    `;
    return tracks.map((track) => track.id);
}

async function selectTrackLevelGenreIds(
    client: RadioSelectionClient,
    pattern: string,
    limit: number,
) {
    const tracks = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM "Track" t
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL} AND (
            EXISTS (
                SELECT 1 FROM unnest(t."lastfmTags") AS tag(name)
                WHERE LOWER(tag.name) LIKE ${pattern} ESCAPE '\\'
            )
            OR EXISTS (
                SELECT 1 FROM unnest(t."essentiaGenres") AS eg(name)
                WHERE LOWER(eg.name) LIKE ${pattern} ESCAPE '\\'
            )
        )
        ORDER BY random()
        LIMIT ${limit * 4}
    `;
    return tracks.map((track) => track.id);
}

async function selectArtistLevelGenreIds(
    client: RadioSelectionClient,
    pattern: string,
    limit: number,
) {
    const tracks = await client.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT t.id, random() AS sort_key
        FROM "Artist" ar
        JOIN "Album" a ON a."artistId" = ar.id
        JOIN "Track" t ON t."albumId" = a.id
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL} AND (
            (ar.genres IS NOT NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
                WHERE LOWER(g.genre) LIKE ${pattern} ESCAPE '\\'
            ))
            OR (ar."userGenres" IS NOT NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(ar."userGenres"::jsonb) AS ug(genre)
                WHERE LOWER(ug.genre) LIKE ${pattern} ESCAPE '\\'
            ))
        )
        ORDER BY sort_key
        LIMIT ${limit * 4}
    `;
    return tracks.map((track) => track.id);
}

async function selectGenreIds(
    client: RadioSelectionClient,
    value: string | undefined,
    limit: number,
) {
    const genre = (value ?? "").toLowerCase();
    const pattern = `%${escapeLikePattern(genre)}%`;
    const trackLevelIds = await selectTrackLevelGenreIds(
        client,
        pattern,
        limit,
    );
    if (trackLevelIds.length >= limit) return trackLevelIds;

    const artistLevelIds = await selectArtistLevelGenreIds(
        client,
        pattern,
        limit,
    );
    const ids = [...new Set([...trackLevelIds, ...artistLevelIds])];
    selectionLogger.debug(`Found ${ids.length} tracks for genre "${genre}"`);
    return ids;
}

const WORKOUT_GENRES = [
    "rock",
    "metal",
    "hard rock",
    "alternative rock",
    "punk",
    "hip hop",
    "rap",
    "trap",
    "electronic",
    "edm",
    "house",
    "techno",
    "drum and bass",
    "dubstep",
    "hardstyle",
    "metalcore",
    "hardcore",
    "industrial",
    "nu metal",
    "pop punk",
] as const;

async function selectAnalyzedWorkoutIds(
    client: RadioSelectionClient,
    limit: number,
) {
    const tracks = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL}
          AND t."analysisStatus" = ${"completed"}
          AND ((t.energy >= ${0.65} AND t.bpm >= ${115})
               OR t."moodTags" && ARRAY[${"workout"}, ${"energetic"}, ${"upbeat"}]::text[])
        ORDER BY random()
        LIMIT ${limit * 4}
    `;
    return tracks.map((track) => track.id);
}

async function selectWorkoutGenreIds(
    client: RadioSelectionClient,
): Promise<string[]> {
    const genres = await client.genre.findMany({
        where: { name: { in: [...WORKOUT_GENRES], mode: "insensitive" } },
        include: { trackGenres: { select: { trackId: true }, take: 50 } },
    });
    return genres.flatMap((genre) =>
        genre.trackGenres.map((trackGenre) => trackGenre.trackId),
    );
}

async function selectWorkoutAlbumGenreIds(
    client: RadioSelectionClient,
    limit: number,
) {
    const tracks = await client.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        WHERE ${VISIBLE_TRACK_SQL} AND ${TRACK_BROWSE_SQL} AND a.genres IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest(${[...WORKOUT_GENRES]}::text[]) AS g(name)
            WHERE (a.genres #>> '{}') LIKE '%' || g.name || '%'
          )
        ORDER BY random()
        LIMIT ${limit * 2}
    `;
    return tracks.map((track) => track.id);
}

async function selectWorkoutIds(
    client: RadioSelectionClient,
    limit: number,
): Promise<string[]> {
    const analyzedIds = await selectAnalyzedWorkoutIds(client, limit);
    if (analyzedIds.length >= limit) return analyzedIds;

    const genreIds = await selectWorkoutGenreIds(client);
    const combinedIds = [...new Set([...analyzedIds, ...genreIds])];
    if (combinedIds.length >= limit) return combinedIds;

    const albumGenreIds = await selectWorkoutAlbumGenreIds(client, limit);
    return [...new Set([...combinedIds, ...albumGenreIds])];
}

async function selectCandidateIds(
    input: LibraryRadioStationSelectionInput,
    client: RadioSelectionClient,
): Promise<string[]> {
    switch (input.type) {
        case "discovery":
            return selectDiscoveryIds(client, input.limit);
        case "favorites":
            return selectFavoritesIds(client, input.limit);
        case "decade":
            return selectDecadeIds(client, input.value, input.limit);
        case "genre":
            return selectGenreIds(client, input.value, input.limit);
        case "workout":
            return selectWorkoutIds(client, input.limit);
    }
}

async function diversifyIds(
    trackIds: string[],
    limit: number,
    client: RadioSelectionClient,
): Promise<string[]> {
    const baseIds = shuffleArray(trackIds).slice(0, Math.max(limit * 4, limit));
    if (baseIds.length === 0) return [];

    const artistRows = await client.track.findMany({
        where: {
            ...TRACK_VISIBLE_WHERE,
            ...TRACK_BROWSE_WHERE,
            id: { in: baseIds },
        },
        select: { id: true, album: { select: { artistId: true } } },
    });
    const artistByTrackId = new Map(
        artistRows.map((row) => [row.id, row.album?.artistId ?? ""]),
    );
    return allocateTracksWithArtistWeighting(
        baseIds,
        (trackId, index) => artistByTrackId.get(trackId) || `unknown:${index}`,
        {
            targetCount: limit,
            alpha: config.generationDiversity.weightAlpha,
            ceilingShare: config.generationDiversity.shareCeiling,
        },
    );
}

async function applyPreferences(
    trackIds: string[],
    userId: string,
    client: RadioSelectionClient,
): Promise<string[]> {
    const scores = await buildTrackPreferenceScoreMapForUser(
        userId,
        trackIds,
        client,
    );
    return scores.size > 0
        ? applyTrackPreferenceOrderBias(trackIds, scores)
        : trackIds;
}

async function loadRadioTracks(
    trackIds: string[],
    client: RadioSelectionClient,
) {
    if (trackIds.length === 0) return [];
    return client.track.findMany({
        where: {
            ...TRACK_VISIBLE_WHERE,
            ...TRACK_BROWSE_WHERE,
            id: { in: trackIds },
        },
        include: {
            album: {
                include: {
                    artist: { select: { id: true, name: true } },
                },
            },
            trackGenres: {
                include: { genre: { select: { name: true } } },
            },
        },
    });
}

/** Selects radio tracks through the supplied client, including locked transactions. */
export async function selectLibraryRadioStationTracks(
    input: LibraryRadioStationSelectionInput,
    client: RadioSelectionClient = prisma,
): Promise<LibraryRadioStationSelection> {
    const candidateIds = await selectCandidateIds(input, client);
    const diversifiedIds = await diversifyIds(
        candidateIds,
        input.limit,
        client,
    );
    const preferredIds = await applyPreferences(
        diversifiedIds,
        input.userId,
        client,
    );
    const finalIds = preferredIds.slice(0, input.limit);
    const rows = await loadRadioTracks(finalIds, client);
    const transformed = rows.map((track) => transformRadioTrack(track, null));
    const tracks = separateArtists(
        shuffleArray(transformed),
        (track) => track.artist?.id ?? `unknown:${track.id}`,
    );
    return { tracks };
}
