import { Artist, Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { normalizeArtistName } from "../utils/artistNormalization";
import { redisClient } from "../utils/redis";
import { lastFmService } from "../services/lastfm";
import {
    prepareAlbumEnrichmentWrite,
    resolveAlbumEnrichmentFields,
    type AlbumEnrichmentWrite,
} from "../services/metadata/albumEnrichmentFields";
import {
    prepareArtistEnrichmentWrite,
    resolveArtistEnrichmentFields,
    resolveArtistMbid,
} from "../services/metadata/artistEnrichmentFields";
import { rgMbidKind } from "../utils/musicIds";

const log = logger.child("ArtistEnrichmentWorker");
const ALBUM_BATCH_SIZE = 3;
const MAX_ALBUMS_PER_ARTIST = 1_000;
const MAX_SIMILAR_ARTISTS = 30;

interface SimilarArtistResult {
    name: string;
    mbid?: string;
    match: number;
}

interface AlbumForEnrichment {
    id: string;
    rgMbid: string | null;
    title: string;
    coverUrl: string | null;
    genres: Prisma.JsonValue;
    label: string | null;
    year: number | null;
    originalYear: number | null;
    artist: { name: string; mbid: string | null };
}

function isMbidUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    return (error as { code?: unknown }).code === "P2002";
}

async function upgradeArtistMbid(artist: Artist): Promise<void> {
    const resolvedMbid = await resolveArtistMbid(artist);
    if (!resolvedMbid || resolvedMbid === artist.mbid) return;
    const existing = await prisma.artist.findUnique({
        where: { mbid: resolvedMbid },
        select: { id: true },
    });
    if (!existing || existing.id === artist.id) {
        try {
            await prisma.artist.update({
                where: { id: artist.id },
                data: { mbid: resolvedMbid },
            });
        } catch (error) {
            if (!isMbidUniqueConstraintError(error)) throw error;
        }
    }
    artist.mbid = resolvedMbid;
}

async function loadSimilarArtists(
    artist: Artist,
): Promise<SimilarArtistResult[]> {
    try {
        const similar = await lastFmService.getSimilarArtists(
            artist.mbid,
            artist.name,
        );
        return similar.slice(0, MAX_SIMILAR_ARTISTS);
    } catch (error) {
        log.debug("Similar artist lookup failed", error);
        return [];
    }
}

async function findLocalSimilarArtist(similar: SimilarArtistResult) {
    if (similar.mbid) {
        const byMbid = await prisma.artist.findUnique({
            where: { mbid: similar.mbid },
        });
        if (byMbid) return byMbid;
    }
    return prisma.artist.findFirst({
        where: { normalizedName: normalizeArtistName(similar.name) },
    });
}

async function upsertSimilarRelationship(
    artistId: string,
    similar: SimilarArtistResult,
): Promise<void> {
    const target = await findLocalSimilarArtist(similar);
    if (!target) return;
    await prisma.similarArtist.upsert({
        where: {
            fromArtistId_toArtistId: {
                fromArtistId: artistId,
                toArtistId: target.id,
            },
        },
        create: {
            fromArtistId: artistId,
            toArtistId: target.id,
            weight: similar.match,
        },
        update: { weight: similar.match },
    });
}

async function persistSimilarArtists(
    artistId: string,
    similarArtists: SimilarArtistResult[],
): Promise<void> {
    if (similarArtists.length === 0) return;
    await prisma.similarArtist.deleteMany({
        where: { fromArtistId: artistId },
    });
    for (let index = 0; index < MAX_SIMILAR_ARTISTS; index += 1) {
        const similar = similarArtists[index];
        if (!similar) return;
        await upsertSimilarRelationship(artistId, similar);
    }
}

function similarArtistsJson(
    similarArtists: SimilarArtistResult[],
): Array<{ name: string; mbid: string | null; match: number }> | null {
    if (similarArtists.length === 0) return null;
    return similarArtists.map((similar) => ({
        name: similar.name,
        mbid: similar.mbid ?? null,
        match: similar.match,
    }));
}

async function cacheArtistHero(
    artistId: string,
    heroUrl: string | null,
): Promise<void> {
    if (!heroUrl) return;
    try {
        await redisClient.setEx(`hero:${artistId}`, 7 * 24 * 60 * 60, heroUrl);
    } catch (error) {
        log.debug("Artist hero cache write failed", error);
    }
}

/** Enrich an artist and its albums through the shared metadata field rules. */
export async function enrichSimilarArtist(artist: Artist): Promise<void> {
    await prisma.artist.update({
        where: { id: artist.id },
        data: { enrichmentStatus: "enriching" },
    });
    try {
        await upgradeArtistMbid(artist);
        const fields = await resolveArtistEnrichmentFields(artist);
        const similarArtists = await loadSimilarArtists(artist);
        const write = await prepareArtistEnrichmentWrite(artist.id, fields);
        await prisma.artist.update({
            where: { id: artist.id },
            data: {
                ...write,
                similarArtistsJson:
                    similarArtistsJson(similarArtists) ?? Prisma.DbNull,
                lastEnriched: new Date(),
                enrichmentStatus: "completed",
            },
        });
        await persistSimilarArtists(artist.id, similarArtists);
        await enrichAlbums(artist.id);
        await cacheArtistHero(artist.id, write.heroUrl);
    } catch (error) {
        log.error(`Artist enrichment failed for ${artist.name}`, error);
        await prisma.artist.update({
            where: { id: artist.id },
            data: { enrichmentStatus: "failed" },
        });
        throw error;
    }
}

function needsGenres(value: Prisma.JsonValue): boolean {
    return value === null || (Array.isArray(value) && value.length === 0);
}

function needsReleaseFields(album: AlbumForEnrichment): boolean {
    if (!album.rgMbid || rgMbidKind(album.rgMbid) === "temp") return true;
    return !album.label || album.year === null || album.originalYear === null;
}

function missingAlbumFields(
    album: AlbumForEnrichment,
    resolved: AlbumEnrichmentWrite,
): AlbumEnrichmentWrite {
    const write: AlbumEnrichmentWrite = {};
    if (!album.coverUrl && resolved.coverUrl)
        write.coverUrl = resolved.coverUrl;
    if (needsGenres(album.genres) && resolved.genres) {
        write.genres = resolved.genres;
    }
    if (!album.label && resolved.label) write.label = resolved.label;
    if (album.year === null && resolved.year) write.year = resolved.year;
    if (album.originalYear === null && resolved.originalYear) {
        write.originalYear = resolved.originalYear;
    }
    if (
        resolved.rgMbid &&
        (!album.rgMbid || rgMbidKind(album.rgMbid) === "temp")
    ) {
        write.rgMbid = resolved.rgMbid;
    }
    return write;
}

async function cacheAlbumCover(
    albumId: string,
    coverUrl: string | undefined,
): Promise<void> {
    if (!coverUrl) return;
    try {
        await redisClient.setEx(
            `album-cover:${albumId}`,
            30 * 24 * 60 * 60,
            coverUrl,
        );
    } catch (error) {
        log.debug("Album cover cache write failed", error);
    }
}

async function enrichAlbum(album: AlbumForEnrichment): Promise<boolean> {
    if (album.rgMbid && rgMbidKind(album.rgMbid) === "federation") {
        return false;
    }
    try {
        const fields = await resolveAlbumEnrichmentFields(album, {
            musicBrainz: needsReleaseFields(album),
            lastFm: needsGenres(album.genres),
            cover: !album.coverUrl,
        });
        const resolved = await prepareAlbumEnrichmentWrite(album.id, fields);
        const write = missingAlbumFields(album, resolved);
        if (Object.keys(write).length === 0) return false;
        await prisma.album.update({ where: { id: album.id }, data: write });
        await cacheAlbumCover(album.id, write.coverUrl);
        return true;
    } catch (error) {
        log.debug(`Album enrichment failed for ${album.title}`, error);
        return false;
    }
}

async function enrichAlbums(artistId: string): Promise<void> {
    const albums = await prisma.album.findMany({
        where: {
            artistId,
            location: { not: "FEDERATED" },
            OR: [
                { coverUrl: null },
                { coverUrl: "" },
                { genres: { equals: Prisma.DbNull } },
                { genres: { equals: [] } },
                { label: null },
                { label: "" },
                { year: null },
                { originalYear: null },
            ],
        },
        select: {
            id: true,
            rgMbid: true,
            title: true,
            coverUrl: true,
            genres: true,
            label: true,
            year: true,
            originalYear: true,
            artist: { select: { name: true, mbid: true } },
        },
        take: MAX_ALBUMS_PER_ARTIST,
    });
    let enrichedCount = 0;
    for (
        let index = 0;
        index < MAX_ALBUMS_PER_ARTIST;
        index += ALBUM_BATCH_SIZE
    ) {
        const batch = albums.slice(index, index + ALBUM_BATCH_SIZE);
        if (batch.length === 0) break;
        const results = await Promise.all(batch.map(enrichAlbum));
        enrichedCount += results.filter(Boolean).length;
    }
    log.debug(`Enriched ${enrichedCount}/${albums.length} albums`);
}
