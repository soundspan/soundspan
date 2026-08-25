import { createHash } from "crypto";
import type { AlbumLocation, Prisma } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { recordCatalogWrite } from "../../metrics";

const MAX_RELEASE_GROUPS_PER_SYNC = 100;
const MAX_TRACKS_PER_SYNC = 500;
const CATALOG_READ_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
const catalogPersistenceLogger = logger.child("CatalogPersistence");

/** Logs a rejected fire-and-forget catalog write without affecting its request. */
export function logCatalogPersistenceError(error: unknown): void {
    catalogPersistenceLogger.warn("Catalog write-through failed", { error });
}

/** MusicBrainz release-group metadata already loaded by an artist view. */
export interface CatalogReleaseGroupInput {
    id?: unknown;
    title?: unknown;
    "first-release-date"?: unknown;
    "primary-type"?: unknown;
}

/** Artist identity and fetched release groups eligible for write-through. */
export interface PersistCatalogReleaseGroupsInput {
    artistId?: string;
    artistMbid?: string | null;
    releaseGroups: readonly CatalogReleaseGroupInput[];
}

/** Track metadata already loaded by a MusicBrainz album view. */
export interface CatalogTrackInput {
    recordingMbid?: unknown;
    title: unknown;
    trackNo: unknown;
    discNo: unknown;
    duration: unknown;
}

/** Catalog album identity and fetched MusicBrainz tracklist. */
export interface PersistCatalogTracklistInput {
    rgMbid: string;
    tracks: readonly CatalogTrackInput[];
}

interface NormalizedReleaseGroup {
    rgMbid: string;
    title: string;
    year: number | null;
    primaryType: string;
}

interface ExistingAlbum {
    rgMbid: string;
    location: AlbumLocation;
    title: string;
    year: number | null;
    primaryType: string;
}

interface NormalizedTrack {
    recordingMbid: string | null;
    title: string;
    trackNo: number;
    discNo: number;
    duration: number;
}

/** Persisted album fields needed to reconstruct a release-group response. */
export interface CatalogReleaseGroupAlbum {
    id: string;
    rgMbid: string;
    title: string;
    year: number | null;
    primaryType: string;
    location: AlbumLocation;
}

/** Local artist catalog snapshot already loaded by the library route. */
export interface ReadFreshCatalogReleaseGroupsInput {
    artistId: string;
    catalogSyncedAt: Date | null;
    albums: readonly CatalogReleaseGroupAlbum[];
}

/** Fresh persisted album and skeleton tracks used by discovery reads. */
export interface FreshCatalogAlbum {
    id: string;
    rgMbid: string;
    title: string;
    year: number | null;
    primaryType: string;
    artist: { id: string; mbid: string; name: string };
    tracks: Array<{
        id: string;
        recordingMbid: string | null;
        title: string;
        trackNo: number;
        discNo: number;
        duration: number;
    }>;
}

function isCatalogPersistenceEnabled(): boolean {
    return config.catalogPersistence.enabled;
}

function isFresh(timestamp: Date | null, now: Date): boolean {
    return (
        timestamp !== null &&
        timestamp.getTime() > now.getTime() - CATALOG_READ_FRESHNESS_MS
    );
}

function releaseGroupFromCatalogAlbum(album: CatalogReleaseGroupAlbum) {
    return {
        id: album.rgMbid,
        title: album.title,
        "first-release-date": album.year === null ? "" : String(album.year),
        "primary-type": album.primaryType,
        "secondary-types": [] as string[],
    };
}

function touchCatalogWhere(where: Prisma.AlbumWhereInput): void {
    void prisma.album
        .updateMany({
            where: { ...where, location: "CATALOG" },
            data: { catalogTouchedAt: new Date() },
        })
        .catch(logCatalogPersistenceError);
}

/** Reconstructs fresh release groups from catalog rows already loaded by a route. */
export function readFreshCatalogReleaseGroups(
    input: ReadFreshCatalogReleaseGroupsInput,
): ReturnType<typeof releaseGroupFromCatalogAlbum>[] | null {
    if (
        !isCatalogPersistenceEnabled() ||
        !isFresh(input.catalogSyncedAt, new Date())
    ) {
        return null;
    }
    const albums = input.albums.filter((album) => album.location === "CATALOG");
    touchCatalogWhere({ artistId: input.artistId });
    return albums.map(releaseGroupFromCatalogAlbum);
}

/** Loads a fresh local artist catalog by MusicBrainz artist ID. */
export async function findFreshCatalogReleaseGroups(artistMbid: string) {
    if (!isCatalogPersistenceEnabled()) return null;
    const artist = await prisma.artist.findFirst({
        where: {
            mbid: artistMbid,
            peerId: null,
            catalogSyncedAt: {
                gt: new Date(Date.now() - CATALOG_READ_FRESHNESS_MS),
            },
        },
        select: {
            id: true,
            catalogSyncedAt: true,
            albums: {
                where: { location: "CATALOG" },
                orderBy: [{ year: "desc" }, { id: "asc" }],
                select: {
                    id: true,
                    rgMbid: true,
                    title: true,
                    year: true,
                    primaryType: true,
                    location: true,
                },
            },
        },
    });
    if (!artist) return null;
    return readFreshCatalogReleaseGroups({
        artistId: artist.id,
        catalogSyncedAt: artist.catalogSyncedAt,
        albums: artist.albums,
    });
}

/** Loads a fresh catalog album with at least one persisted skeleton track. */
export async function findFreshCatalogAlbum(
    rgMbid: string,
): Promise<FreshCatalogAlbum | null> {
    if (!isCatalogPersistenceEnabled()) return null;
    const album = await prisma.album.findFirst({
        where: {
            rgMbid,
            location: "CATALOG",
            catalogTouchedAt: {
                gt: new Date(Date.now() - CATALOG_READ_FRESHNESS_MS),
            },
            tracks: { some: {} },
        },
        select: {
            id: true,
            rgMbid: true,
            title: true,
            year: true,
            primaryType: true,
            artist: { select: { id: true, mbid: true, name: true } },
            tracks: {
                orderBy: [{ discNo: "asc" }, { trackNo: "asc" }, { id: "asc" }],
                select: {
                    id: true,
                    recordingMbid: true,
                    title: true,
                    trackNo: true,
                    discNo: true,
                    duration: true,
                },
            },
        },
    });
    if (!album) return null;
    touchCatalogWhere({ id: album.id });
    return album;
}

function normalizedYear(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})/.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    return Number.isSafeInteger(year) ? year : null;
}

function normalizeReleaseGroup(
    input: CatalogReleaseGroupInput,
): NormalizedReleaseGroup | null {
    const rgMbid = typeof input.id === "string" ? input.id.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!rgMbid || !title) return null;
    const primaryType =
        typeof input["primary-type"] === "string" &&
        input["primary-type"].trim()
            ? input["primary-type"].trim()
            : "Album";
    return {
        rgMbid,
        title,
        year: normalizedYear(input["first-release-date"]),
        primaryType,
    };
}

function normalizeReleaseGroups(
    inputs: readonly CatalogReleaseGroupInput[],
): NormalizedReleaseGroup[] {
    const groups = new Map<string, NormalizedReleaseGroup>();
    const limit = Math.min(inputs.length, MAX_RELEASE_GROUPS_PER_SYNC);
    for (let index = 0; index < limit; index += 1) {
        const group = normalizeReleaseGroup(inputs[index]);
        if (group) groups.set(group.rgMbid, group);
    }
    return [...groups.values()];
}

async function resolveArtistId(
    input: PersistCatalogReleaseGroupsInput,
): Promise<string | null> {
    const artistId = input.artistId?.trim();
    if (artistId) return artistId;
    const artistMbid = input.artistMbid?.trim();
    if (!artistMbid) return null;
    const artist = await prisma.artist.findFirst({
        where: { mbid: artistMbid, peerId: null },
        select: { id: true },
    });
    return artist?.id ?? null;
}

function missingCatalogAlbumData(
    existing: ExistingAlbum,
    incoming: NormalizedReleaseGroup,
    now: Date,
): Prisma.AlbumUpdateManyMutationInput {
    const data: Prisma.AlbumUpdateManyMutationInput = {
        catalogTouchedAt: now,
    };
    if (!existing.title.trim()) data.title = incoming.title;
    if (existing.year === null && incoming.year !== null) {
        data.year = incoming.year;
    }
    if (!existing.primaryType.trim()) data.primaryType = incoming.primaryType;
    return data;
}

async function refreshCatalogAlbums(
    groups: readonly NormalizedReleaseGroup[],
    existingByMbid: ReadonlyMap<string, ExistingAlbum>,
    now: Date,
): Promise<void> {
    const limit = Math.min(groups.length, MAX_RELEASE_GROUPS_PER_SYNC);
    for (let index = 0; index < limit; index += 1) {
        const incoming = groups[index];
        const existing = existingByMbid.get(incoming.rgMbid);
        if (!existing || existing.location !== "CATALOG") continue;
        await prisma.album.updateMany({
            where: { rgMbid: incoming.rgMbid, location: "CATALOG" },
            data: missingCatalogAlbumData(existing, incoming, now),
        });
    }
}

async function createCatalogAlbums(
    artistId: string,
    groups: readonly NormalizedReleaseGroup[],
    existingByMbid: ReadonlyMap<string, ExistingAlbum>,
    now: Date,
): Promise<void> {
    const data = groups
        .filter((group) => !existingByMbid.has(group.rgMbid))
        .map((group) => ({
            artistId,
            catalogTouchedAt: now,
            location: "CATALOG" as const,
            primaryType: group.primaryType,
            rgMbid: group.rgMbid,
            title: group.title,
            year: group.year,
        }));
    if (data.length === 0) return;
    await prisma.album.createMany({ data, skipDuplicates: true });
}

/** Persists bounded catalog album skeletons without changing existing content rows. */
export async function persistCatalogReleaseGroups(
    input: PersistCatalogReleaseGroupsInput,
): Promise<void> {
    if (!isCatalogPersistenceEnabled()) return;
    const artistId = await resolveArtistId(input);
    if (!artistId) return;
    const groups = normalizeReleaseGroups(input.releaseGroups);
    const existing = groups.length
        ? await prisma.album.findMany({
              where: { rgMbid: { in: groups.map((group) => group.rgMbid) } },
              select: {
                  rgMbid: true,
                  location: true,
                  title: true,
                  year: true,
                  primaryType: true,
              },
          })
        : [];
    const existingByMbid = new Map(
        existing.map((album) => [album.rgMbid, album]),
    );
    const now = new Date();
    await refreshCatalogAlbums(groups, existingByMbid, now);
    await createCatalogAlbums(artistId, groups, existingByMbid, now);
    await prisma.artist.update({
        where: { id: artistId },
        data: { catalogSyncedAt: now },
    });
    if (groups.length > 0) recordCatalogWrite("release_group");
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : fallback;
}

function normalizeDuration(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : 0;
}

function normalizeTrack(input: CatalogTrackInput): NormalizedTrack | null {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) return null;
    return {
        recordingMbid:
            typeof input.recordingMbid === "string" &&
            input.recordingMbid.trim()
                ? input.recordingMbid.trim()
                : null,
        title,
        trackNo: normalizePositiveInteger(input.trackNo, 1),
        discNo: normalizePositiveInteger(input.discNo, 1),
        duration: normalizeDuration(input.duration),
    };
}

function catalogTrackId(albumId: string, track: NormalizedTrack): string {
    const identity = JSON.stringify([
        albumId,
        track.discNo,
        track.trackNo,
        track.title,
    ]);
    return `catalog-track:${createHash("sha256").update(identity).digest("hex")}`;
}

async function upsertCatalogTracks(
    albumId: string,
    inputs: readonly CatalogTrackInput[],
    now: Date,
): Promise<number> {
    const limit = Math.min(inputs.length, MAX_TRACKS_PER_SYNC);
    let written = 0;
    for (let index = 0; index < limit; index += 1) {
        const track = normalizeTrack(inputs[index]);
        if (!track) continue;
        const id = catalogTrackId(albumId, track);
        await prisma.track.upsert({
            where: { id },
            create: {
                id,
                albumId,
                ...track,
                fileModified: now,
                filePath: null,
                fileSize: 0,
                origin: "LOCAL",
            },
            update: track,
        });
        written += 1;
    }
    return written;
}

/** Persists a bounded MusicBrainz tracklist only beneath a CATALOG album. */
export async function persistCatalogTracklist(
    input: PersistCatalogTracklistInput,
): Promise<void> {
    if (!isCatalogPersistenceEnabled()) return;
    const rgMbid = input.rgMbid.trim();
    if (!rgMbid) return;
    const album = await prisma.album.findUnique({
        where: { rgMbid },
        select: { id: true, location: true },
    });
    if (!album || album.location !== "CATALOG") return;
    const now = new Date();
    const written = await upsertCatalogTracks(album.id, input.tracks, now);
    await prisma.album.updateMany({
        where: { id: album.id, location: "CATALOG" },
        data: { catalogTouchedAt: now },
    });
    if (written > 0) recordCatalogWrite("tracklist");
}
