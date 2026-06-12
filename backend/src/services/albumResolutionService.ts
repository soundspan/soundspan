import { createHash } from "crypto";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    normalizeAlbumTitle,
    stripAlbumEdition,
} from "../utils/artistNormalization";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("AlbumResolutionService")
        : logger;

/** Titles treated as "no album" — albumId stays null on the remote track. */
const GENERIC_ALBUM_TITLES = new Set([
    "",
    "single",
    "singles",
    "unknown album",
    "unknown",
    "n/a",
    "none",
]);

/**
 * Result of resolving an album for a remote track.
 */
export interface AlbumResolutionResult {
    id: string;
    title: string;
    created: boolean;
}

/**
 * Resolve a raw album title string to an existing Album entity or create a new one.
 *
 * Returns null when the title is empty, "Single", "Unknown Album", or similar —
 * the albumId on the remote track stays null.
 *
 * Algorithm:
 * 1. Guard generic/empty titles -> null
 * 2. Exact match (case-insensitive) scoped to artistId
 * 3. Edition-stripped match
 * 4. Create new REMOTE album
 */
export async function resolveAlbumForRemoteTrack(
    rawAlbumTitle: string,
    artistId: string,
    provider: "tidal" | "youtube"
): Promise<AlbumResolutionResult | null> {
    // 1. Guard generic titles
    if (!rawAlbumTitle || GENERIC_ALBUM_TITLES.has(rawAlbumTitle.trim().toLowerCase())) {
        return null;
    }

    const trimmedTitle = rawAlbumTitle.trim();

    // 2. Exact match (case-insensitive) for this artist
    const exactMatch = await prisma.album.findFirst({
        where: {
            artistId,
            title: { equals: trimmedTitle, mode: "insensitive" },
        },
        select: { id: true, title: true },
    });

    if (exactMatch) {
        return { id: exactMatch.id, title: exactMatch.title, created: false };
    }

    // 3. Edition-stripped match
    const strippedInput = stripAlbumEdition(trimmedTitle);
    const normalizedInput = normalizeAlbumTitle(strippedInput);

    if (normalizedInput && normalizedInput !== normalizeAlbumTitle(trimmedTitle)) {
        // The input had edition info stripped — search for the stripped form
        const strippedMatch = await prisma.album.findFirst({
            where: {
                artistId,
                title: { equals: strippedInput, mode: "insensitive" },
            },
            select: { id: true, title: true },
        });

        if (strippedMatch) {
            return { id: strippedMatch.id, title: strippedMatch.title, created: false };
        }
    }

    // Also try matching existing albums after stripping their editions
    const candidateAlbums = await prisma.album.findMany({
        where: { artistId },
        select: { id: true, title: true },
        take: 100,
    });

    for (const candidate of candidateAlbums) {
        const candidateStripped = normalizeAlbumTitle(stripAlbumEdition(candidate.title));
        if (candidateStripped === normalizedInput) {
            return { id: candidate.id, title: candidate.title, created: false };
        }
    }

    // 4. Create new REMOTE album
    return createRemoteAlbum(trimmedTitle, artistId, provider);
}

/**
 * Build a deterministic synthetic rgMbid for a remote album.
 * Same (artistId, normalized title) always produces the same value,
 * regardless of provider — so tidal and youtube resolve to the same album entity.
 */
export function buildSyntheticRgMbid(
    artistId: string,
    normalizedTitle: string
): string {
    const hash = createHash("sha256")
        .update(`${artistId}|${normalizedTitle}`)
        .digest("hex")
        .slice(0, 16);
    return `remote:${hash}`;
}

/**
 * Create a new Album entity with location=REMOTE and a synthetic rgMbid.
 * Uses createMany(skipDuplicates) to avoid unique-constraint error races.
 */
async function createRemoteAlbum(
    title: string,
    artistId: string,
    provider: "tidal" | "youtube"
): Promise<AlbumResolutionResult> {
    const normalizedTitle = normalizeAlbumTitle(title);
    const rgMbid = buildSyntheticRgMbid(artistId, normalizedTitle);
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
            `Failed to resolve remote album row after createMany for rgMbid=${rgMbid}`
        );
    }
    if (insertResult.count > 0) {
        log.info(
            `Resolved remote album "${title}" id=${resolved.id} for artistId=${artistId} (provider=${provider})`
        );
    } else {
        log.debug(
            `Album creation raced for "${title}" artistId=${artistId}; reusing id=${resolved.id}`
        );
    }
    return { id: resolved.id, title: resolved.title, created: false };
}
