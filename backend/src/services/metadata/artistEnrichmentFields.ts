import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { isRealArtistMbid } from "../../utils/musicIds";
import { downloadAndStoreImage, isNativePath } from "../imageStorage";
import { lastFmService } from "../lastfm";
import { musicBrainzService } from "../musicbrainz";
import { wikidataService } from "../wikidata";
import { resolveArtistImage } from "./artistImageResolver";

const log = logger.child("ArtistEnrichmentFields");
const MAX_ARTIST_TAGS = 5;

/** Artist identity used to resolve canonical enrichment fields. */
export interface ArtistEnrichmentInput {
    id: string;
    name: string;
    mbid: string | null;
}

/** Compatibility payload returned by manual artist enrichment. */
export interface ArtistEnrichmentData {
    mbid?: string;
    bio?: string;
    genres?: string[];
    tags?: string[];
    similarArtists?: string[];
    heroUrl?: string;
    formed?: number;
    confidence: number;
}

/** Prisma artist-column values owned by the shared enrichment rules. */
export interface ArtistEnrichmentWrite {
    mbid?: string;
    summary: string | null;
    heroUrl: string | null;
    genres?: string[];
}

interface ArtistResolveOptions {
    includeSimilarArtists?: boolean;
}

interface ArtistMetadata {
    bio?: string;
    tags?: string[];
    genres?: string[];
    found: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function artistBio(info: unknown): string | undefined {
    const bio = asRecord(asRecord(info)?.bio);
    return nonEmptyString(bio?.summary) ?? nonEmptyString(bio?.content);
}

function artistTags(info: unknown): string[] {
    const rawTags = asRecord(asRecord(info)?.tags)?.tag;
    if (!Array.isArray(rawTags)) return [];
    return rawTags
        .slice(0, 100)
        .map((tag) => nonEmptyString(asRecord(tag)?.name))
        .filter((name): name is string => name !== undefined);
}

function firstArtistMbid(results: unknown): string | null {
    if (!Array.isArray(results)) return null;
    const first = asRecord(results[0]);
    const mbid = nonEmptyString(first?.id);
    return mbid && isRealArtistMbid(mbid) ? mbid : null;
}

/** Resolve the real artist MBID used by every enrichment caller. */
export async function resolveArtistMbid(
    input: ArtistEnrichmentInput,
): Promise<string | null> {
    if (isRealArtistMbid(input.mbid)) return input.mbid;
    try {
        const results = await musicBrainzService.searchArtist(input.name, 1);
        return firstArtistMbid(results);
    } catch (error) {
        log.debug("MusicBrainz artist lookup failed", error);
        return null;
    }
}

async function wikidataSummary(
    input: ArtistEnrichmentInput,
    mbid: string | null,
): Promise<string | undefined> {
    if (!mbid) return undefined;
    try {
        const info = await wikidataService.getArtistInfo(input.name, mbid);
        return nonEmptyString(asRecord(info)?.summary);
    } catch (error) {
        log.debug("Wikidata artist lookup failed", error);
        return undefined;
    }
}

async function resolveArtistMetadata(
    input: ArtistEnrichmentInput,
    mbid: string | null,
): Promise<ArtistMetadata> {
    const preferredBio = await wikidataSummary(input, mbid);
    try {
        const info = await lastFmService.getArtistInfo(
            input.name,
            mbid ?? undefined,
        );
        if (!info) return { bio: preferredBio, found: Boolean(preferredBio) };
        const tags = artistTags(info);
        return {
            bio: preferredBio ?? artistBio(info),
            tags,
            genres: tags.slice(0, MAX_ARTIST_TAGS),
            found: true,
        };
    } catch (error) {
        log.debug("Last.fm artist lookup failed", error);
        return { bio: preferredBio, found: Boolean(preferredBio) };
    }
}

async function resolveHeroUrl(
    input: ArtistEnrichmentInput,
    mbid: string | null,
): Promise<string | undefined> {
    try {
        const image = await resolveArtistImage({
            artistName: input.name,
            mbid,
        });
        return image?.url;
    } catch (error) {
        log.debug("Artist image resolution failed", error);
        return undefined;
    }
}

async function resolveSimilarArtistNames(
    input: ArtistEnrichmentInput,
    mbid: string | null,
): Promise<string[]> {
    try {
        const similar = await lastFmService.getSimilarArtists(
            mbid ?? "",
            input.name,
            10,
        );
        return similar.slice(0, 10).map((artist) => artist.name);
    } catch (error) {
        log.debug("Last.fm similar-artist lookup failed", error);
        return [];
    }
}

function addMetadata(
    data: ArtistEnrichmentData,
    metadata: ArtistMetadata,
): void {
    if (metadata.bio !== undefined) data.bio = metadata.bio;
    if (metadata.tags !== undefined) data.tags = metadata.tags;
    if (metadata.genres !== undefined) data.genres = metadata.genres;
    if (metadata.found) data.confidence += 0.3;
}

/** Resolve artist fields with Wikidata-first bio and five Last.fm genres. */
export async function resolveArtistEnrichmentFields(
    input: ArtistEnrichmentInput,
    options: ArtistResolveOptions = {},
): Promise<ArtistEnrichmentData> {
    const data: ArtistEnrichmentData = { confidence: 0 };
    const resolvedMbid = await resolveArtistMbid(input);
    if (resolvedMbid && resolvedMbid !== input.mbid) {
        data.mbid = resolvedMbid;
        data.confidence += 0.4;
    }

    const metadata = await resolveArtistMetadata(input, resolvedMbid);
    addMetadata(data, metadata);
    const heroUrl = await resolveHeroUrl(input, resolvedMbid);
    if (heroUrl) {
        data.heroUrl = heroUrl;
        data.confidence += 0.2;
    }
    if (options.includeSimilarArtists && metadata.found) {
        data.similarArtists = await resolveSimilarArtistNames(
            input,
            resolvedMbid,
        );
    }
    return data;
}

/** Load an artist and resolve the compatibility payload for the admin route. */
export async function enrichArtistFields(
    artistId: string,
): Promise<ArtistEnrichmentData> {
    const artist = await prisma.artist.findUnique({
        where: { id: artistId },
        select: { id: true, name: true, mbid: true },
    });
    if (!artist) throw new Error(`Artist ${artistId} not found`);
    return resolveArtistEnrichmentFields(artist, {
        includeSimilarArtists: true,
    });
}

async function resolvedWriteMbid(
    artistId: string,
    mbid: string | undefined,
): Promise<string | undefined> {
    if (!mbid) return undefined;
    const existing = await prisma.artist.findUnique({
        where: { mbid },
        select: { id: true },
    });
    return !existing || existing.id === artistId ? mbid : undefined;
}

async function localArtistHero(
    artistId: string,
    heroUrl: string | undefined,
): Promise<string | null> {
    if (!heroUrl) return null;
    if (isNativePath(heroUrl)) return heroUrl;
    return (
        (await downloadAndStoreImage(heroUrl, artistId, "artist")) ?? heroUrl
    );
}

/** Prepare the exact artist columns shared by worker and admin persistence. */
export async function prepareArtistEnrichmentWrite(
    artistId: string,
    data: ArtistEnrichmentData,
): Promise<ArtistEnrichmentWrite> {
    const write: ArtistEnrichmentWrite = {
        summary: data.bio ?? null,
        heroUrl: await localArtistHero(artistId, data.heroUrl),
    };
    const mbid = await resolvedWriteMbid(artistId, data.mbid);
    if (mbid) write.mbid = mbid;
    if (data.genres && data.genres.length > 0) write.genres = data.genres;
    return write;
}

/** Persist artist enrichment using the worker-owned field mapping. */
export async function applyArtistEnrichmentFields(
    artistId: string,
    data: ArtistEnrichmentData,
): Promise<void> {
    const write = await prepareArtistEnrichmentWrite(artistId, data);
    await prisma.artist.update({ where: { id: artistId }, data: write });
}
