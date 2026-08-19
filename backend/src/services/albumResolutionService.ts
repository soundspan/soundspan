import { createHash } from "crypto";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    normalizeAlbumTitle,
    stripAlbumEdition,
} from "../utils/artistNormalization";
import type { ExternalTrackAlbumResolution } from "./trackAlbumResolution";
import { isGenericAlbumTitle } from "./albumTitleGuards";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("AlbumResolutionService")
        : logger;

/**
 * Result of resolving an album for a remote track.
 */
export interface AlbumResolutionResult {
    id: string;
    title: string;
    created: boolean;
}

/** Track identity used when a remote provider has no usable album tag. */
export interface RemoteTrackAlbumContext {
    artistName: string;
    trackTitle: string;
}

/**
 * Resolve a raw album title string to an existing Album entity or create a new one.
 *
 * Empty and placeholder titles use external track metadata when track identity
 * is available. They remain unlinked when external resolution misses.
 *
 * Algorithm:
 * 1. Resolve generic/empty titles from track metadata when available
 * 2. Exact match (case-insensitive) scoped to artistId
 * 3. Edition-stripped match
 * 4. Create new REMOTE album
 */
export async function resolveAlbumForRemoteTrack(
    rawAlbumTitle: string | null | undefined,
    artistId: string,
    provider: "tidal" | "youtube",
    track?: RemoteTrackAlbumContext,
): Promise<AlbumResolutionResult | null> {
    if (isGenericAlbumTitle(rawAlbumTitle)) {
        return resolveGenericAlbum(rawAlbumTitle, artistId, provider, track);
    }

    const trimmedTitle = rawAlbumTitle?.trim();
    if (!trimmedTitle) return null;
    const existing = await findExistingAlbum(trimmedTitle, artistId);
    return existing ?? createRemoteAlbum(trimmedTitle, artistId, provider);
}

async function findExistingAlbum(
    title: string,
    artistId: string,
): Promise<AlbumResolutionResult | null> {
    const exactMatch = await prisma.album.findFirst({
        where: {
            artistId,
            title: { equals: title, mode: "insensitive" },
        },
        select: { id: true, title: true },
    });
    if (exactMatch) {
        return { id: exactMatch.id, title: exactMatch.title, created: false };
    }

    const strippedInput = stripAlbumEdition(title);
    const normalizedInput = normalizeAlbumTitle(strippedInput);
    if (normalizedInput && normalizedInput !== normalizeAlbumTitle(title)) {
        const strippedMatch = await prisma.album.findFirst({
            where: {
                artistId,
                title: { equals: strippedInput, mode: "insensitive" },
            },
            select: { id: true, title: true },
        });
        if (strippedMatch) {
            return {
                id: strippedMatch.id,
                title: strippedMatch.title,
                created: false,
            };
        }
    }

    const candidateAlbums = await prisma.album.findMany({
        where: { artistId },
        select: { id: true, title: true },
        take: 100,
    });

    for (const candidate of candidateAlbums) {
        const candidateStripped = normalizeAlbumTitle(
            stripAlbumEdition(candidate.title),
        );
        if (candidateStripped === normalizedInput) {
            return { id: candidate.id, title: candidate.title, created: false };
        }
    }
    return null;
}

async function resolveGenericAlbum(
    rawAlbumTitle: string | null | undefined,
    artistId: string,
    provider: "tidal" | "youtube",
    track?: RemoteTrackAlbumContext,
): Promise<AlbumResolutionResult | null> {
    if (!track) return null;
    const { resolveAlbumForExternalTrack } =
        await import("./trackAlbumResolution");
    const outcome = await resolveAlbumForExternalTrack({
        artistName: track.artistName,
        trackTitle: track.trackTitle,
        albumTitle: rawAlbumTitle?.trim() || undefined,
    });
    if (outcome.status !== "resolved") return null;

    try {
        return await resolveExternalAlbum(
            outcome.resolution,
            artistId,
            provider,
        );
    } catch (error) {
        log.warn("Failed to persist resolved remote album", {
            artistId,
            provider,
            error,
        });
        throw error;
    }
}

/**
 * Build a deterministic synthetic rgMbid for a remote album.
 * Same (artistId, normalized title) always produces the same value,
 * regardless of provider — so tidal and youtube resolve to the same album entity.
 */
export function buildSyntheticRgMbid(
    artistId: string,
    normalizedTitle: string,
): string {
    const hash = createHash("sha256")
        .update(`${artistId}|${normalizedTitle}`)
        .digest("hex")
        .slice(0, 16);
    return `remote:${hash}`;
}

/**
 * Create a new REMOTE Album with a resolved rgMbid when supplied, otherwise a
 * deterministic synthetic rgMbid.
 * Uses createMany(skipDuplicates) to avoid unique-constraint error races.
 */
async function createRemoteAlbum(
    title: string,
    artistId: string,
    provider: "tidal" | "youtube",
    resolvedRgMbid?: string,
): Promise<AlbumResolutionResult> {
    const normalizedTitle = normalizeAlbumTitle(title);
    const rgMbid =
        resolvedRgMbid ?? buildSyntheticRgMbid(artistId, normalizedTitle);
    const insertResult = await prisma.album.createMany({
        data: {
            title,
            artistId,
            rgMbid,
            location: "REMOTE",
            primaryType: "Album",
        },
        skipDuplicates: true,
    });
    const resolved = await prisma.album.findUnique({
        where: { rgMbid },
        select: { id: true, title: true },
    });
    if (!resolved) {
        throw new Error(
            `Failed to resolve remote album row after createMany for rgMbid=${rgMbid}`,
        );
    }
    if (insertResult.count > 0) {
        log.info(
            `Resolved remote album "${title}" id=${resolved.id} for artistId=${artistId} (provider=${provider})`,
        );
    } else {
        log.debug(
            `Album creation raced for "${title}" artistId=${artistId}; reusing id=${resolved.id}`,
        );
    }
    return { id: resolved.id, title: resolved.title, created: false };
}

async function resolveExternalAlbum(
    external: ExternalTrackAlbumResolution,
    artistId: string,
    provider: "tidal" | "youtube",
): Promise<AlbumResolutionResult> {
    const existing = await findExistingAlbum(external.albumTitle, artistId);
    if (existing) return existing;

    return createRemoteAlbum(
        external.albumTitle,
        artistId,
        provider,
        external.rgMbid,
    );
}
