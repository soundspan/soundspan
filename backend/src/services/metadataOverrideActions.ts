import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import { updateAlbumMetadataWithOwnership } from "./albumMetadataPersistence";

const log = logger.child("MetadataOverrides");

export const artistMetadataSchema = z
    .object({
        name: z.string().nullable().optional(),
        bio: z.string().nullable().optional(),
        genres: z.array(z.string()).optional(),
        heroUrl: z.string().nullable().optional(),
        mbid: z.unknown().optional(),
    })
    .passthrough();
export const albumMetadataSchema = z
    .object({
        title: z.string().nullable().optional(),
        year: z.union([z.number(), z.string()]).optional(),
        genres: z.array(z.string()).optional(),
        coverUrl: z.string().nullable().optional(),
        rgMbid: z.unknown().optional(),
    })
    .passthrough();
export const trackMetadataSchema = z
    .object({
        title: z.string().nullable().optional(),
        trackNo: z.union([z.number(), z.string()]).optional(),
    })
    .passthrough();

export type MetadataEntity = {
    type: "artist" | "album" | "track";
    id: string;
};

export interface MetadataField {
    target: string;
    marksOverride?: boolean;
    transform?: (value: unknown) => unknown;
}

export type MetadataFieldMap = Readonly<Record<string, MetadataField>>;

export class MetadataEntityNotFoundError extends Error {
    constructor(readonly entityType: MetadataEntity["type"]) {
        super(`${entityType} not found`);
        this.name = "MetadataEntityNotFoundError";
    }
}

function buildUpdateData(
    body: Readonly<Record<string, unknown>>,
    fieldMap: MetadataFieldMap,
): Record<string, unknown> {
    const updateData: Record<string, unknown> = {};
    let hasOverrides = false;
    for (const [source, field] of Object.entries(fieldMap)) {
        const value = body[source];
        if (value === undefined) continue;
        updateData[field.target] = field.transform
            ? field.transform(value)
            : value;
        hasOverrides ||= field.marksOverride !== false;
    }
    if (hasOverrides) updateData.hasUserOverrides = true;
    return updateData;
}

async function updateArtist(id: string, data: Record<string, unknown>) {
    const artist = await prisma.artist.update({
        where: { id },
        data: data as Prisma.ArtistUpdateInput,
        include: {
            albums: {
                select: { id: true, title: true, year: true, coverUrl: true },
            },
        },
    });
    try {
        await redisClient.del(`hero:${id}`);
    } catch (error) {
        log.warn("Failed to invalidate artist hero cache", { error, id });
    }
    return artist;
}

async function updateTrack(id: string, data: Record<string, unknown>) {
    return prisma.track.update({
        where: { id },
        data: data as Prisma.TrackUpdateInput,
        include: {
            album: {
                select: {
                    id: true,
                    title: true,
                    artist: { select: { id: true, name: true } },
                },
            },
        },
    });
}

/** Maps defined input fields to non-destructive metadata updates and persists them. */
export async function applyMetadataOverrides(
    entity: MetadataEntity,
    body: Readonly<Record<string, unknown>>,
    fieldMap: MetadataFieldMap,
) {
    const data = buildUpdateData(body, fieldMap);
    switch (entity.type) {
        case "artist":
            return updateArtist(entity.id, data);
        case "album":
            return updateAlbumMetadataWithOwnership(
                entity.id,
                data as Prisma.AlbumUpdateInput,
            );
        case "track":
            return updateTrack(entity.id, data);
    }
}

async function resetArtist(id: string) {
    const existing = await prisma.artist.findUnique({
        where: { id },
        select: { id: true },
    });
    if (!existing) throw new MetadataEntityNotFoundError("artist");
    return updateArtist(id, {
        displayName: null,
        userSummary: null,
        userHeroUrl: null,
        userGenres: [],
        hasUserOverrides: false,
    });
}

async function resetAlbum(id: string) {
    const existing = await prisma.album.findUnique({
        where: { id },
        select: { id: true },
    });
    if (!existing) throw new MetadataEntityNotFoundError("album");
    return updateAlbumMetadataWithOwnership(id, {
        displayTitle: null,
        displayYear: null,
        userCoverUrl: null,
        userGenres: [],
        hasUserOverrides: false,
    });
}

async function resetTrack(id: string) {
    const existing = await prisma.track.findFirst({
        where: { id, ...TRACK_VISIBLE_WHERE },
        select: { id: true },
    });
    if (!existing) throw new MetadataEntityNotFoundError("track");
    return updateTrack(id, {
        displayTitle: null,
        displayTrackNo: null,
        hasUserOverrides: false,
    });
}

/** Clears display overrides while preserving each entity's canonical metadata. */
export async function resetMetadataOverrides(entity: MetadataEntity) {
    switch (entity.type) {
        case "artist":
            return resetArtist(entity.id);
        case "album":
            return resetAlbum(entity.id);
        case "track":
            return resetTrack(entity.id);
    }
}
