import type { Prisma } from "@prisma/client";
import {
    areArtistNamesSimilar,
    normalizeArtistName,
    normalizeForExactKey,
} from "../utils/artistNormalization";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { selectPreferredScannerAlbumCandidate } from "./scannerAlbumIdentityPolicy";

type ScannerArtist = Pick<
    Prisma.ArtistGetPayload<object>,
    "id" | "mbid" | "name" | "normalizedName"
>;

type ScannerAlbum = Pick<
    Prisma.AlbumGetPayload<object>,
    "coverUrl" | "id" | "location" | "rgMbid" | "title"
>;

type ScannerAlbumMatchCandidate = ScannerAlbum & {
    activeTrackCount: number;
};

interface ArtistResolution {
    artist: ScannerArtist;
    artistName: string;
    matchKind: "created" | "exact" | "fuzzy" | "mbid";
}

type NamedArtistResolution = Omit<ArtistResolution, "matchKind">;

interface AlbumResolution {
    album: ScannerAlbum;
    wasMissing: boolean;
}

interface ArtistResolutionInput {
    artistMbid?: string;
    artistName: string;
    extractedPrimaryArtist: string;
    rawArtistName: string;
}

interface AlbumResolutionInput {
    albumMbid?: string;
    albumPromotions: Map<string, Promise<void>>;
    albumTitle: string;
    artistId: string;
    isDiscoveryAlbum: boolean;
    year: number | null;
}

let artistCreationTail: Promise<void> = Promise.resolve();

function runSerializedArtistCreation<T>(work: () => Promise<T>): Promise<T> {
    const result = artistCreationTail.then(work, work);
    artistCreationTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === code,
    );
}

async function findArtistByName(
    input: ArtistResolutionInput,
): Promise<NamedArtistResolution | null> {
    let artist = await prisma.artist.findFirst({
        where: { normalizedName: normalizeArtistName(input.artistName) },
    });
    let artistName = input.artistName;
    if (!artist && input.extractedPrimaryArtist !== input.rawArtistName) {
        artist = await prisma.artist.findFirst({
            where: {
                normalizedName: normalizeArtistName(input.rawArtistName),
            },
        });
        if (artist) artistName = input.rawArtistName;
    }
    return artist ? { artist, artistName } : null;
}

async function findFuzzyArtist(
    artistName: string,
): Promise<ScannerArtist | null> {
    const normalizedName = normalizeArtistName(artistName);
    const candidates = await prisma.artist.findMany({
        where: {
            normalizedName: {
                startsWith: normalizedName.substring(
                    0,
                    Math.min(3, normalizedName.length),
                ),
            },
        },
        select: { id: true, name: true, normalizedName: true, mbid: true },
    });
    for (const candidate of candidates) {
        if (areArtistNamesSimilar(artistName, candidate.name, 95)) {
            logger.debug(
                `Fuzzy match found: "${artistName}" -> "${candidate.name}"`,
            );
            return candidate;
        }
    }
    return null;
}

async function consolidateTemporaryArtist(
    artistMbid: string,
    normalizedName: string,
): Promise<ScannerArtist | null> {
    const temporaryArtist = await prisma.artist.findFirst({
        where: {
            normalizedName,
            mbid: { startsWith: "temp-" },
        },
    });
    if (!temporaryArtist) return null;
    logger.debug(
        `[SCANNER] Consolidating temp artist "${temporaryArtist.name}" with real MBID: ${artistMbid}`,
    );
    try {
        return await prisma.artist.update({
            where: { id: temporaryArtist.id },
            data: { mbid: artistMbid },
        });
    } catch (error: unknown) {
        if (!hasErrorCode(error, "P2002")) throw error;
        const canonicalArtist = await prisma.artist.findUnique({
            where: { mbid: artistMbid },
        });
        if (canonicalArtist) return canonicalArtist;
        logger.warn(
            `[SCANNER] MBID collision detected for ${artistMbid}, but canonical artist lookup returned null; keeping temp artist linkage`,
        );
        return temporaryArtist;
    }
}

async function findArtistByMbid(
    artistMbid: string | undefined,
    normalizedName: string,
): Promise<ScannerArtist | null> {
    if (!artistMbid) return null;
    const artist = await prisma.artist.findUnique({
        where: { mbid: artistMbid },
    });
    if (artist) return artist;
    return consolidateTemporaryArtist(artistMbid, normalizedName);
}

async function createArtist(
    artistName: string,
    artistMbid: string | undefined,
): Promise<ScannerArtist> {
    try {
        return await prisma.artist.create({
            data: {
                name: artistName,
                normalizedName: normalizeArtistName(artistName),
                mbid: artistMbid || `temp-${Date.now()}-${Math.random()}`,
                enrichmentStatus: "pending",
            },
        });
    } catch (error: unknown) {
        if (!hasErrorCode(error, "P2002") || !artistMbid) throw error;
        const existingArtist = await prisma.artist.findUnique({
            where: { mbid: artistMbid },
        });
        if (!existingArtist) throw error;
        logger.debug(
            `[SCANNER] Artist create raced on MBID ${artistMbid}; reusing existing artist "${existingArtist.name}"`,
        );
        return existingArtist;
    }
}

async function findExistingArtist(
    input: ArtistResolutionInput,
): Promise<ArtistResolution | null> {
    const namedArtist = await findArtistByName(input);
    if (namedArtist) return { ...namedArtist, matchKind: "exact" };
    const fuzzyArtist = await findFuzzyArtist(input.artistName);
    if (fuzzyArtist) {
        return {
            artist: fuzzyArtist,
            artistName: input.artistName,
            matchKind: "fuzzy",
        };
    }
    const normalizedName = normalizeArtistName(input.artistName);
    const mbidArtist = await findArtistByMbid(input.artistMbid, normalizedName);
    if (!mbidArtist) return null;
    return {
        artist: mbidArtist,
        artistName: input.artistName,
        matchKind: "mbid",
    };
}

/** Resolves or creates the durable artist identity for one scanned file. */
export async function resolveScannerArtist(
    input: ArtistResolutionInput,
): Promise<ArtistResolution> {
    const existingArtist = await findExistingArtist(input);
    if (existingArtist) return existingArtist;
    return runSerializedArtistCreation(async () => {
        const recheckedArtist = await findExistingArtist(input);
        if (recheckedArtist) return recheckedArtist;
        const artist = await createArtist(input.artistName, input.artistMbid);
        return { artist, artistName: input.artistName, matchKind: "created" };
    });
}

async function findAlbum(
    artistId: string,
    albumTitle: string,
    albumMbid?: string,
): Promise<ScannerAlbum | null> {
    const scopedAlbum = albumMbid
        ? await prisma.album.findFirst({
              where: { artistId, rgMbid: albumMbid },
          })
        : await findUntaggedAlbum(artistId, albumTitle);
    if (scopedAlbum || !albumMbid) return scopedAlbum;
    return prisma.album.findUnique({ where: { rgMbid: albumMbid } });
}

async function findUntaggedAlbum(
    artistId: string,
    albumTitle: string,
): Promise<ScannerAlbum | null> {
    // The resolution ladder intentionally has no directory evidence, matching
    // albumResolutionService. Real-rgMbid preference and the post-scan dedup
    // pass bound the known same-title edition risk.
    const insensitiveMatches = await prisma.album.findMany({
        where: {
            artistId,
            title: { equals: albumTitle, mode: "insensitive" },
        },
        orderBy: { id: "asc" },
        take: 100,
        select: {
            coverUrl: true,
            id: true,
            location: true,
            rgMbid: true,
            title: true,
            _count: { select: { tracks: { where: { removedAt: null } } } },
        },
    });
    const normalizedTitle = normalizeForExactKey(albumTitle);
    // This deterministic scan is capped until normalized identity is stored;
    // the bounded post-scan dedup pass self-heals deferred duplicates.
    const candidates = await prisma.album.findMany({
        where: { artistId },
        orderBy: { id: "asc" },
        select: {
            coverUrl: true,
            id: true,
            location: true,
            rgMbid: true,
            title: true,
            _count: { select: { tracks: { where: { removedAt: null } } } },
        },
        take: 100,
    });
    const matches = new Map<string, ScannerAlbumMatchCandidate>();
    for (const candidate of [...insensitiveMatches, ...candidates]) {
        if (normalizeForExactKey(candidate.title) !== normalizedTitle) continue;
        matches.set(candidate.id, {
            coverUrl: candidate.coverUrl,
            id: candidate.id,
            location: candidate.location,
            rgMbid: candidate.rgMbid,
            title: candidate.title,
            activeTrackCount: candidate._count.tracks,
        });
    }
    const preferred = selectPreferredScannerAlbumCandidate([
        ...matches.values(),
    ]);
    if (!preferred) return null;
    return {
        coverUrl: preferred.coverUrl,
        id: preferred.id,
        location: preferred.location,
        rgMbid: preferred.rgMbid,
        title: preferred.title,
    };
}

async function createAlbum(
    input: AlbumResolutionInput,
    rgMbid: string,
): Promise<ScannerAlbum> {
    return prisma.$transaction(async (transaction) => {
        const album = await transaction.album.create({
            data: {
                title: input.albumTitle,
                artistId: input.artistId,
                rgMbid,
                year: input.year,
                primaryType: "Album",
                location: input.isDiscoveryAlbum ? "DISCOVER" : "LIBRARY",
            },
        });
        if (!input.isDiscoveryAlbum) {
            await transaction.ownedAlbum.create({
                data: {
                    artistId: input.artistId,
                    rgMbid,
                    source: "native_scan",
                },
            });
            input.albumPromotions.set(album.id, Promise.resolve());
        }
        return album;
    });
}

/** Resolves or creates the durable album identity for one scanned file. */
export async function resolveScannerAlbum(
    input: AlbumResolutionInput,
): Promise<AlbumResolution> {
    const existingAlbum = await findAlbum(
        input.artistId,
        input.albumTitle,
        input.albumMbid,
    );
    if (existingAlbum) return { album: existingAlbum, wasMissing: false };
    const rgMbid = input.albumMbid || `temp-${Date.now()}-${Math.random()}`;
    try {
        const album = await createAlbum(input, rgMbid);
        return { album, wasMissing: true };
    } catch (error: unknown) {
        if (!hasErrorCode(error, "P2002")) throw error;
        const racedAlbum = await prisma.album.findUnique({ where: { rgMbid } });
        if (!racedAlbum) throw error;
        logger.debug(
            `[SCANNER] Album create raced on rgMbid ${rgMbid}; reusing existing album "${racedAlbum.title}"`,
        );
        return { album: racedAlbum, wasMissing: true };
    }
}
