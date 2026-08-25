import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { isRealArtistMbid, rgMbidKind } from "../../utils/musicIds";
import { downloadAndStoreImage, isNativePath } from "../imageStorage";
import { lastFmService } from "../lastfm";
import { musicBrainzService } from "../musicbrainz";
import { resolveAlbumCover } from "./albumCoverResolver";

const log = logger.child("AlbumEnrichmentFields");
const MAX_RELEASE_GROUPS = 50;
const MAX_ALBUM_TAGS = 5;

/** Album identity used to resolve canonical enrichment fields. */
export interface AlbumEnrichmentInput {
    id: string;
    title: string;
    rgMbid: string | null;
    artist: {
        name: string;
        mbid: string | null;
    };
}

/** Compatibility payload returned by manual album enrichment. */
export interface AlbumEnrichmentData {
    rgMbid?: string;
    releaseDate?: Date;
    albumType?: string;
    genres?: string[];
    tags?: string[];
    label?: string;
    coverUrl?: string;
    trackCount?: number;
    confidence: number;
}

/** Prisma album-column values owned by the shared enrichment rules. */
export interface AlbumEnrichmentWrite {
    rgMbid?: string;
    coverUrl?: string;
    originalYear?: number;
    year?: number;
    label?: string;
    genres?: string[];
}

/** Provider groups needed for one album enrichment resolution. */
export interface AlbumEnrichmentOptions {
    musicBrainz?: boolean;
    lastFm?: boolean;
    cover?: boolean;
}

interface ReleaseGroupResolution {
    lookupMbid: string | null;
    data: Pick<
        AlbumEnrichmentData,
        "rgMbid" | "releaseDate" | "albumType" | "label"
    >;
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

function normalizedTitle(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchingReleaseGroup(results: unknown, title: string): unknown {
    if (!Array.isArray(results)) return undefined;
    const target = normalizedTitle(title);
    return results.slice(0, MAX_RELEASE_GROUPS).find((candidate) => {
        const candidateTitle = nonEmptyString(asRecord(candidate)?.title);
        return candidateTitle
            ? normalizedTitle(candidateTitle) === target
            : false;
    });
}

function releaseDate(value: unknown): Date | undefined {
    const raw = nonEmptyString(value);
    if (!raw) return undefined;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function firstReleaseId(details: unknown): string | undefined {
    const releases = asRecord(details)?.releases;
    if (!Array.isArray(releases)) return undefined;
    return nonEmptyString(asRecord(releases[0])?.id);
}

function firstLabelName(release: unknown): string | undefined {
    const labelInfo = asRecord(release)?.["label-info"];
    if (!Array.isArray(labelInfo)) return undefined;
    return nonEmptyString(asRecord(asRecord(labelInfo[0])?.label)?.name);
}

async function loadReleaseGroupDetails(rgMbid: string): Promise<unknown> {
    try {
        return await musicBrainzService.getReleaseGroup(rgMbid);
    } catch (error) {
        log.debug("MusicBrainz release-group lookup failed", error);
        return null;
    }
}

async function loadReleaseLabel(details: unknown): Promise<string | undefined> {
    const releaseId = firstReleaseId(details);
    if (!releaseId) return undefined;
    try {
        return firstLabelName(await musicBrainzService.getRelease(releaseId));
    } catch (error) {
        log.debug("MusicBrainz release lookup failed", error);
        return undefined;
    }
}

async function existingReleaseGroup(
    rgMbid: string,
): Promise<ReleaseGroupResolution> {
    const details = await loadReleaseGroupDetails(rgMbid);
    return {
        lookupMbid: rgMbid,
        data: {
            releaseDate: releaseDate(asRecord(details)?.["first-release-date"]),
            label: await loadReleaseLabel(details),
        },
        found: true,
    };
}

function searchedReleaseData(
    match: Record<string, unknown>,
    details: unknown,
    rgMbid: string,
    label: string | undefined,
): ReleaseGroupResolution["data"] {
    return {
        rgMbid,
        albumType: nonEmptyString(match["primary-type"]),
        releaseDate:
            releaseDate(match["first-release-date"]) ??
            releaseDate(asRecord(details)?.["first-release-date"]),
        label,
    };
}

async function searchedReleaseGroup(
    input: AlbumEnrichmentInput,
): Promise<ReleaseGroupResolution> {
    const artistMbid = input.artist.mbid;
    if (!artistMbid || !isRealArtistMbid(artistMbid)) {
        return { lookupMbid: null, data: {}, found: false };
    }
    try {
        const groups = await musicBrainzService.getReleaseGroups(
            artistMbid,
            ["album", "ep"],
            MAX_RELEASE_GROUPS,
        );
        const match = asRecord(matchingReleaseGroup(groups, input.title));
        const rgMbid = nonEmptyString(match?.id);
        if (!match || !rgMbid) {
            return { lookupMbid: null, data: {}, found: false };
        }
        const details = await loadReleaseGroupDetails(rgMbid);
        const label = await loadReleaseLabel(details);
        return {
            lookupMbid: rgMbid,
            data: searchedReleaseData(match, details, rgMbid, label),
            found: true,
        };
    } catch (error) {
        log.debug("MusicBrainz album search failed", error);
        return { lookupMbid: null, data: {}, found: false };
    }
}

async function resolveReleaseGroup(
    input: AlbumEnrichmentInput,
): Promise<ReleaseGroupResolution> {
    if (input.rgMbid) {
        const kind = rgMbidKind(input.rgMbid);
        if (kind === "musicbrainz") {
            return existingReleaseGroup(input.rgMbid);
        }
        if (kind === "remote" || kind === "federation") {
            return { lookupMbid: null, data: {}, found: false };
        }
    }
    return searchedReleaseGroup(input);
}

function albumTags(info: unknown): string[] {
    const rawTags = asRecord(asRecord(info)?.tags)?.tag;
    if (!Array.isArray(rawTags)) return [];
    return rawTags
        .slice(0, 100)
        .map((tag) => nonEmptyString(asRecord(tag)?.name))
        .filter((name): name is string => name !== undefined);
}

function albumTrackCount(info: unknown): number | undefined {
    const tracks = asRecord(asRecord(info)?.tracks)?.track;
    return Array.isArray(tracks) ? tracks.length : undefined;
}

async function addLastFmFields(
    input: AlbumEnrichmentInput,
    data: AlbumEnrichmentData,
): Promise<void> {
    try {
        const info = await lastFmService.getAlbumInfo(
            input.artist.name,
            input.title,
        );
        if (!info) return;
        const tags = albumTags(info);
        data.tags = tags;
        data.genres = tags.slice(0, MAX_ALBUM_TAGS);
        data.trackCount = albumTrackCount(info);
        data.confidence += 0.3;
    } catch (error) {
        log.debug("Last.fm album lookup failed", error);
    }
}

async function addCoverField(
    input: AlbumEnrichmentInput,
    rgMbid: string | null,
    data: AlbumEnrichmentData,
): Promise<void> {
    try {
        const resolution = await resolveAlbumCover({
            artistName: input.artist.name,
            albumTitle: input.title,
            rgMbid: rgMbid ?? input.rgMbid,
        });
        if (!resolution) return;
        data.coverUrl = resolution.url;
        data.confidence += 0.2;
    } catch (error) {
        log.debug("Album cover resolution failed", error);
    }
}

/** Resolve MusicBrainz album fields, five Last.fm genres, and canonical cover. */
export async function resolveAlbumEnrichmentFields(
    input: AlbumEnrichmentInput,
    options: AlbumEnrichmentOptions = {},
): Promise<AlbumEnrichmentData> {
    const data: AlbumEnrichmentData = { confidence: 0 };
    const releaseGroup =
        options.musicBrainz === false
            ? { lookupMbid: null, data: {}, found: false }
            : await resolveReleaseGroup(input);
    Object.assign(data, releaseGroup.data);
    if (releaseGroup.found) data.confidence += 0.5;
    if (options.lastFm !== false) await addLastFmFields(input, data);
    if (options.cover !== false) {
        await addCoverField(input, releaseGroup.lookupMbid, data);
    }
    return data;
}

/** Load an album and resolve the compatibility payload for the admin route. */
export async function enrichAlbumFields(
    albumId: string,
): Promise<AlbumEnrichmentData> {
    const album = await prisma.album.findUnique({
        where: { id: albumId },
        select: {
            id: true,
            title: true,
            rgMbid: true,
            artist: { select: { name: true, mbid: true } },
        },
    });
    if (!album) throw new Error(`Album ${albumId} not found`);
    return resolveAlbumEnrichmentFields(album);
}

async function localAlbumCover(
    albumId: string,
    coverUrl: string | undefined,
): Promise<string | undefined> {
    if (!coverUrl || isNativePath(coverUrl)) return coverUrl;
    return (
        (await downloadAndStoreImage(coverUrl, albumId, "album")) ?? coverUrl
    );
}

/** Prepare the exact album columns shared by worker and admin persistence. */
export async function prepareAlbumEnrichmentWrite(
    albumId: string,
    data: AlbumEnrichmentData,
): Promise<AlbumEnrichmentWrite> {
    const write: AlbumEnrichmentWrite = {};
    if (data.rgMbid) write.rgMbid = data.rgMbid;
    const coverUrl = await localAlbumCover(albumId, data.coverUrl);
    if (coverUrl) write.coverUrl = coverUrl;
    if (data.releaseDate) {
        const year = data.releaseDate.getUTCFullYear();
        write.originalYear = year;
        write.year = year;
    }
    if (data.label) write.label = data.label;
    if (data.genres && data.genres.length > 0) write.genres = data.genres;
    return write;
}

/** Persist album enrichment using the scheduled-worker field mapping. */
export async function applyAlbumEnrichmentFields(
    albumId: string,
    data: AlbumEnrichmentData,
): Promise<void> {
    const write = await prepareAlbumEnrichmentWrite(albumId, data);
    if (Object.keys(write).length === 0) return;
    await prisma.album.update({ where: { id: albumId }, data: write });
}
