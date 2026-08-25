import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
    AlbumEnvelope,
    ArtistEnvelope,
    RemoteAlbumRow,
    RemoteArtistRow,
    RemoteTrackRow,
    TrackEnvelope,
} from "./federationSyncPage";
import { syncedFederationTrackValues } from "./federationSyncTrackValues";

/** Transaction-scoped raw-write surface used by federation page upserts. */
export type FederationPageWriteClient = Pick<
    Prisma.TransactionClient,
    "$executeRaw"
>;

function serializedPayload(rows: readonly object[]): string[] {
    return rows.map((row) => JSON.stringify(row));
}

function assertAffectedRows(actual: number, expected: number): void {
    if (actual !== expected) {
        throw new Error(
            `Federation page upsert affected ${actual} of ${expected} rows`,
        );
    }
}

/** Upserts one bounded artist page through one parameter-bound statement. */
export async function upsertFederationArtistPage(
    transaction: FederationPageWriteClient,
    peerId: string,
    rows: readonly {
        item: ArtistEnvelope;
        mbid: string;
        existingId?: string;
    }[],
): Promise<RemoteArtistRow[]> {
    if (rows.length === 0) return [];
    const persisted = rows.map(({ item, mbid, existingId }) => ({
        id: existingId ?? `fed:${randomUUID()}`,
        remoteId: item.id,
        mbid,
    }));
    const payload = serializedPayload(
        rows.map(({ item, mbid }, index) => ({
            id: persisted[index].id,
            peerId,
            remoteId: item.id,
            mbid,
            name: item.attributes.name,
            normalizedName: item.attributes.normalizedName,
            lastSynced: new Date(item.updatedAt).toISOString(),
        })),
    );
    const affected = await transaction.$executeRaw`
        WITH input AS (
            SELECT raw::jsonb AS value
            FROM unnest(${payload}::text[]) AS serialized(raw)
        )
        INSERT INTO "Artist" AS target
            (id, "peerId", "remoteId", mbid, name, "normalizedName",
             "lastSynced", "updatedAt")
        SELECT value->>'id', value->>'peerId', value->>'remoteId',
               value->>'mbid', value->>'name', value->>'normalizedName',
               (value->>'lastSynced')::timestamp(3), NOW()
        FROM input
        ON CONFLICT ("peerId", "remoteId") DO UPDATE SET
            name = EXCLUDED.name,
            "normalizedName" = EXCLUDED."normalizedName",
            "lastSynced" = EXCLUDED."lastSynced",
            "updatedAt" = NOW()
    `;
    assertAffectedRows(affected, rows.length);
    return persisted;
}

/** Upserts one bounded album page through one parameter-bound statement. */
export async function upsertFederationAlbumPage(
    transaction: FederationPageWriteClient,
    peerId: string,
    rows: readonly {
        item: AlbumEnvelope;
        artistId: string;
        rgMbid: string;
        existingId?: string;
    }[],
): Promise<RemoteAlbumRow[]> {
    if (rows.length === 0) return [];
    const persisted = rows.map(({ item, artistId, rgMbid, existingId }) => ({
        id: existingId ?? `fed:${randomUUID()}`,
        remoteId: item.id,
        artistId,
        rgMbid,
    }));
    const payload = serializedPayload(
        rows.map(({ item, artistId, rgMbid }, index) => ({
            id: persisted[index].id,
            peerId,
            remoteId: item.id,
            artistId,
            rgMbid,
            title: item.attributes.title,
            year: item.attributes.year,
            primaryType: item.attributes.primaryType,
            lastSynced: new Date(item.updatedAt).toISOString(),
        })),
    );
    const affected = await transaction.$executeRaw`
        WITH input AS (
            SELECT raw::jsonb AS value
            FROM unnest(${payload}::text[]) AS serialized(raw)
        )
        INSERT INTO "Album" AS target
            (id, "peerId", "remoteId", "artistId", "rgMbid", title, year,
             "primaryType", location, "lastSynced", "updatedAt")
        SELECT value->>'id', value->>'peerId', value->>'remoteId',
               value->>'artistId', value->>'rgMbid', value->>'title',
               (value->>'year')::integer, value->>'primaryType',
               'FEDERATED', (value->>'lastSynced')::timestamp(3), NOW()
        FROM input
        ON CONFLICT ("peerId", "remoteId") DO UPDATE SET
            "artistId" = EXCLUDED."artistId",
            title = EXCLUDED.title,
            year = EXCLUDED.year,
            "primaryType" = EXCLUDED."primaryType",
            "lastSynced" = EXCLUDED."lastSynced",
            "updatedAt" = NOW()
    `;
    assertAffectedRows(affected, rows.length);
    return persisted;
}

function trackPayload(
    peerId: string,
    item: TrackEnvelope,
    album: RemoteAlbumRow,
    id: string,
): object {
    const values = syncedFederationTrackValues(item, album.id);
    return {
        id,
        peerId,
        remoteId: item.id,
        ...values,
        fileModified: values.fileModified.toISOString(),
    };
}

/** Upserts one bounded track page through one parameter-bound statement. */
export async function upsertFederationTrackPage(
    transaction: FederationPageWriteClient,
    peerId: string,
    rows: readonly {
        item: TrackEnvelope;
        album: RemoteAlbumRow;
        existing: RemoteTrackRow | null;
    }[],
): Promise<RemoteTrackRow[]> {
    if (rows.length === 0) return [];
    const persisted = rows.map(({ item, existing }) => ({
        id: existing?.id ?? `fed:${randomUUID()}`,
        remoteId: item.id,
        audioHash:
            item.attributes.audioHash === undefined
                ? (existing?.audioHash ?? null)
                : item.attributes.audioHash,
    }));
    const payload = serializedPayload(
        rows.map(({ item, album }, index) =>
            trackPayload(peerId, item, album, persisted[index].id),
        ),
    );
    const affected = await transaction.$executeRaw`
        WITH input AS (
            SELECT raw::jsonb AS value
            FROM unnest(${payload}::text[]) AS serialized(raw)
        )
        INSERT INTO "Track" AS target
            (id, "peerId", "remoteId", "albumId", title, "discNo", "trackNo",
             duration, mime, "fileSize", "fileModified", origin, "filePath",
             "removedAt", "recordingMbid", isrc, "audioHash", bpm, "beatsCount",
             key, "keyScale", "keyStrength", energy, loudness, "loudnessLufs",
             "truePeakDb", "dynamicRange", danceability, valence, arousal,
             instrumentalness, acousticness, speechiness, "moodHappy", "moodSad",
             "moodRelaxed", "moodAggressive", "moodParty", "moodAcoustic",
             "moodElectronic", "danceabilityMl", "moodTags", "essentiaGenres",
             "lastfmTags", "updatedAt")
        SELECT value->>'id', value->>'peerId', value->>'remoteId',
               value->>'albumId', value->>'title', (value->>'discNo')::integer,
               (value->>'trackNo')::integer, (value->>'duration')::integer,
               value->>'mime', (value->>'fileSize')::integer,
               (value->>'fileModified')::timestamp(3), 'FEDERATED', NULL, NULL,
               value->>'recordingMbid', value->>'isrc', value->>'audioHash',
               (value->>'bpm')::double precision, (value->>'beatsCount')::integer,
               value->>'key', value->>'keyScale',
               (value->>'keyStrength')::double precision,
               (value->>'energy')::double precision,
               (value->>'loudness')::double precision,
               (value->>'loudnessLufs')::double precision,
               (value->>'truePeakDb')::double precision,
               (value->>'dynamicRange')::double precision,
               (value->>'danceability')::double precision,
               (value->>'valence')::double precision,
               (value->>'arousal')::double precision,
               (value->>'instrumentalness')::double precision,
               (value->>'acousticness')::double precision,
               (value->>'speechiness')::double precision,
               (value->>'moodHappy')::double precision,
               (value->>'moodSad')::double precision,
               (value->>'moodRelaxed')::double precision,
               (value->>'moodAggressive')::double precision,
               (value->>'moodParty')::double precision,
               (value->>'moodAcoustic')::double precision,
               (value->>'moodElectronic')::double precision,
               (value->>'danceabilityMl')::double precision,
               ARRAY(SELECT jsonb_array_elements_text(value->'moodTags')),
               ARRAY(SELECT jsonb_array_elements_text(value->'essentiaGenres')),
               ARRAY(SELECT jsonb_array_elements_text(value->'lastfmTags')), NOW()
        FROM input
        ON CONFLICT ("peerId", "remoteId") DO UPDATE SET
            "albumId" = EXCLUDED."albumId", title = EXCLUDED.title,
            "discNo" = EXCLUDED."discNo", "trackNo" = EXCLUDED."trackNo",
            duration = EXCLUDED.duration, mime = EXCLUDED.mime,
            "fileSize" = EXCLUDED."fileSize", "fileModified" = EXCLUDED."fileModified",
            "recordingMbid" = EXCLUDED."recordingMbid", isrc = EXCLUDED.isrc,
            "audioHash" = EXCLUDED."audioHash",
            bpm = CASE WHEN (SELECT value ? 'bpm' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.bpm ELSE target.bpm END,
            "beatsCount" = CASE WHEN (SELECT value ? 'beatsCount' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."beatsCount" ELSE target."beatsCount" END,
            key = CASE WHEN (SELECT value ? 'key' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.key ELSE target.key END,
            "keyScale" = CASE WHEN (SELECT value ? 'keyScale' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."keyScale" ELSE target."keyScale" END,
            "keyStrength" = CASE WHEN (SELECT value ? 'keyStrength' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."keyStrength" ELSE target."keyStrength" END,
            energy = CASE WHEN (SELECT value ? 'energy' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.energy ELSE target.energy END,
            loudness = CASE WHEN (SELECT value ? 'loudness' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.loudness ELSE target.loudness END,
            "loudnessLufs" = CASE WHEN (SELECT value ? 'loudnessLufs' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."loudnessLufs" ELSE target."loudnessLufs" END,
            "truePeakDb" = CASE WHEN (SELECT value ? 'truePeakDb' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."truePeakDb" ELSE target."truePeakDb" END,
            "dynamicRange" = CASE WHEN (SELECT value ? 'dynamicRange' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."dynamicRange" ELSE target."dynamicRange" END,
            danceability = CASE WHEN (SELECT value ? 'danceability' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.danceability ELSE target.danceability END,
            valence = CASE WHEN (SELECT value ? 'valence' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.valence ELSE target.valence END,
            arousal = CASE WHEN (SELECT value ? 'arousal' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.arousal ELSE target.arousal END,
            instrumentalness = CASE WHEN (SELECT value ? 'instrumentalness' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.instrumentalness ELSE target.instrumentalness END,
            acousticness = CASE WHEN (SELECT value ? 'acousticness' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.acousticness ELSE target.acousticness END,
            speechiness = CASE WHEN (SELECT value ? 'speechiness' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED.speechiness ELSE target.speechiness END,
            "moodHappy" = CASE WHEN (SELECT value ? 'moodHappy' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodHappy" ELSE target."moodHappy" END,
            "moodSad" = CASE WHEN (SELECT value ? 'moodSad' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodSad" ELSE target."moodSad" END,
            "moodRelaxed" = CASE WHEN (SELECT value ? 'moodRelaxed' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodRelaxed" ELSE target."moodRelaxed" END,
            "moodAggressive" = CASE WHEN (SELECT value ? 'moodAggressive' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodAggressive" ELSE target."moodAggressive" END,
            "moodParty" = CASE WHEN (SELECT value ? 'moodParty' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodParty" ELSE target."moodParty" END,
            "moodAcoustic" = CASE WHEN (SELECT value ? 'moodAcoustic' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodAcoustic" ELSE target."moodAcoustic" END,
            "moodElectronic" = CASE WHEN (SELECT value ? 'moodElectronic' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."moodElectronic" ELSE target."moodElectronic" END,
            "danceabilityMl" = CASE WHEN (SELECT value ? 'danceabilityMl' FROM input WHERE value->>'remoteId' = EXCLUDED."remoteId") THEN EXCLUDED."danceabilityMl" ELSE target."danceabilityMl" END,
            "moodTags" = EXCLUDED."moodTags",
            "essentiaGenres" = EXCLUDED."essentiaGenres", "lastfmTags" = EXCLUDED."lastfmTags",
            origin = 'FEDERATED', "filePath" = NULL, "removedAt" = NULL,
            "updatedAt" = NOW()
    `;
    assertAffectedRows(affected, rows.length);
    return persisted;
}
