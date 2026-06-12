import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    normalizeArtistName,
    extractPrimaryArtist,
    areArtistNamesSimilar,
    canonicalizeVariousArtists,
    getPreferredArtistName,
    VARIOUS_ARTISTS_CANONICAL,
    VARIOUS_ARTISTS_MBID,
} from "../utils/artistNormalization";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("ArtistResolutionService")
        : logger;

/**
 * Result of resolving an artist for a remote track.
 */
export interface ArtistResolutionResult {
    id: string;
    name: string;
    created: boolean;
}

/**
 * Resolve a raw artist name string to an existing Artist entity or create a new one.
 *
 * Algorithm:
 * 1. Guard empty/null -> "Unknown Artist"
 * 2. Canonicalize Various Artists
 * 3. Extract primary artist (strip feat./ft. collaborators)
 * 4. Normalize name for matching
 * 5. Exact match on normalizedName
 * 6. Fuzzy match at 95% threshold
 * 7. Create new lightweight Artist entity
 */
export async function resolveArtistForRemoteTrack(
    rawArtistName: string
): Promise<ArtistResolutionResult> {
    // 1. Guard empty/null
    if (!rawArtistName || rawArtistName.trim() === "") {
        return resolveOrCreateByName("Unknown Artist");
    }

    const trimmed = rawArtistName.trim();

    // 2. Canonicalize Various Artists
    const canonicalized = canonicalizeVariousArtists(trimmed);
    if (canonicalized === VARIOUS_ARTISTS_CANONICAL) {
        return resolveVariousArtists();
    }

    // 3. Extract primary artist
    const primaryArtist = extractPrimaryArtist(canonicalized);

    // 4. Normalize for matching
    const normalizedName = normalizeArtistName(primaryArtist);
    if (!normalizedName) {
        return resolveOrCreateByName("Unknown Artist");
    }

    // 5. Exact match
    const exactMatch = await prisma.artist.findFirst({
        where: { normalizedName },
        select: { id: true, name: true },
    });

    if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.name, created: false };
    }

    // 6. Fuzzy match — query candidates sharing a prefix
    const prefix = normalizedName.slice(0, 3);
    if (prefix.length >= 3) {
        const candidates = await prisma.artist.findMany({
            where: { normalizedName: { startsWith: prefix } },
            select: { id: true, name: true, normalizedName: true },
            take: 50,
        });

        for (const candidate of candidates) {
            if (areArtistNamesSimilar(normalizedName, candidate.normalizedName, 95)) {
                // Update name if incoming has diacritics (prefer accented form)
                const preferred = getPreferredArtistName(candidate.name, primaryArtist);
                if (preferred !== candidate.name) {
                    await prisma.artist.update({
                        where: { id: candidate.id },
                        data: { name: preferred },
                    });
                }
                return { id: candidate.id, name: preferred, created: false };
            }
        }
    }

    // 7. Create new artist
    return createNewArtist(primaryArtist, normalizedName);
}

/**
 * Resolve or create the canonical Various Artists entity.
 */
async function resolveVariousArtists(): Promise<ArtistResolutionResult> {
    const existing = await prisma.artist.findUnique({
        where: { mbid: VARIOUS_ARTISTS_MBID },
        select: { id: true, name: true },
    });

    if (existing) {
        return { id: existing.id, name: existing.name, created: false };
    }

    try {
        const created = await prisma.artist.create({
            data: {
                name: VARIOUS_ARTISTS_CANONICAL,
                normalizedName: normalizeArtistName(VARIOUS_ARTISTS_CANONICAL),
                mbid: VARIOUS_ARTISTS_MBID,
                enrichmentStatus: "pending",
            },
        });
        log.info(`Created Various Artists entity id=${created.id}`);
        return { id: created.id, name: created.name, created: true };
    } catch (error: unknown) {
        if (isPrismaUniqueConstraintError(error)) {
            const retried = await prisma.artist.findUnique({
                where: { mbid: VARIOUS_ARTISTS_MBID },
                select: { id: true, name: true },
            });
            if (retried) {
                return { id: retried.id, name: retried.name, created: false };
            }
        }
        throw error;
    }
}

/**
 * Resolve or create an artist by display name (used for "Unknown Artist" fallback).
 */
async function resolveOrCreateByName(
    displayName: string
): Promise<ArtistResolutionResult> {
    const normalized = normalizeArtistName(displayName);
    const existing = await prisma.artist.findFirst({
        where: { normalizedName: normalized },
        select: { id: true, name: true },
    });

    if (existing) {
        return { id: existing.id, name: existing.name, created: false };
    }

    return createNewArtist(displayName, normalized);
}

/**
 * Create a new Artist entity with a temporary MBID.
 * Handles P2002 unique constraint races by retrying with a find.
 */
async function createNewArtist(
    name: string,
    normalizedName: string
): Promise<ArtistResolutionResult> {
    const tempMbid = `temp-remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const created = await prisma.artist.create({
            data: {
                name,
                normalizedName,
                mbid: tempMbid,
                enrichmentStatus: "pending",
            },
        });
        log.info(`Created remote artist "${name}" id=${created.id}`);
        return { id: created.id, name: created.name, created: true };
    } catch (error: unknown) {
        if (isPrismaUniqueConstraintError(error)) {
            log.debug(`Artist creation race for "${name}", resolving existing`);
            const retried = await prisma.artist.findFirst({
                where: { normalizedName },
                select: { id: true, name: true },
            });
            if (retried) {
                return { id: retried.id, name: retried.name, created: false };
            }
        }
        throw error;
    }
}

/**
 * Check if a Prisma error is a P2002 unique constraint violation.
 */
function isPrismaUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { code?: unknown; message?: unknown };
    if (maybeError.code === "P2002") return true;
    if (typeof maybeError.message === "string") {
        return maybeError.message.includes("Unique constraint failed");
    }
    return false;
}
