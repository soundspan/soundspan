import type { Job } from "bull";
import { z } from "zod";
import {
    createFederationClient,
    FederationEpochMismatchError,
    FederationHttpError,
    FederationStaleCursorError,
    type FederationEnvelope,
    type FederationManifest,
} from "../../services/federationClient";
import { backfillAllArtistCounts } from "../../services/artistCountsService";
import { trackMappingService } from "../../services/trackMappingService";
import { decodeFederationIdentity } from "../../utils/federationDedup";
import { upsertTrackEmbedding } from "../../services/trackEmbeddings";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const log = logger.child("FederationSyncProcessor");
const OVERLAP_MS = 5 * 60 * 1_000;
const MAX_REMOTE_PAGES = 10_000;
const CLEANUP_BATCH_SIZE = 200;
const MAX_CLEANUP_PAGES = 10_000;
const MAX_SEEN_ITEMS = 2_000_000;

const jobDataSchema = z.strictObject({
    peerId: z.string().trim().min(1).max(128),
});

type MediaType = FederationEnvelope["mediaType"];
type ArtistEnvelope = Extract<FederationEnvelope, { mediaType: "artist" }>;
type AlbumEnvelope = Extract<FederationEnvelope, { mediaType: "album" }>;
type TrackEnvelope = Extract<FederationEnvelope, { mediaType: "track" }>;
type ParentMediaType = "artist" | "album";

interface SyncCounts {
    artists: number;
    albums: number;
    tracks: number;
    tombstones: number;
}

interface SyncContext {
    peerId: string;
    scopes: string[];
    counts: SyncCounts;
    seen: Record<MediaType, Set<string>>;
    albumRgMbids: Map<string, string>;
    unavailableParents: Record<ParentMediaType, Set<string>>;
    warnedParents: Set<string>;
    skippedInvalid: number;
}

/** Bounded summary of one completed peer sync. */
export interface FederationSyncResult extends SyncCounts {
    mode: "full" | "incremental";
    cursor: string;
    skippedInvalid: number;
}

function newSyncContext(peerId: string, scopes: string[]): SyncContext {
    return {
        peerId,
        scopes,
        counts: { artists: 0, albums: 0, tracks: 0, tombstones: 0 },
        seen: { artist: new Set(), album: new Set(), track: new Set() },
        albumRgMbids: new Map(),
        unavailableParents: { artist: new Set(), album: new Set() },
        warnedParents: new Set(),
        skippedInvalid: 0,
    };
}

function incrementCount(context: SyncContext, mediaType: MediaType): void {
    if (mediaType === "artist") context.counts.artists += 1;
    else if (mediaType === "album") context.counts.albums += 1;
    else context.counts.tracks += 1;
}

function rememberSeen(context: SyncContext, item: FederationEnvelope): void {
    const seen = context.seen[item.mediaType];
    if (seen.size >= MAX_SEEN_ITEMS) {
        throw new Error("Federation full sync exceeded the item bound");
    }
    seen.add(item.id);
}

function placeholderIdentity(peerId: string, value: string): string {
    const encoded = Buffer.from(value, "utf8").toString("base64url");
    return `federation:${peerId}:${encoded}`;
}

function warnParentRecovery(
    context: SyncContext,
    mediaType: ParentMediaType,
    remoteId: string,
    action: string,
): void {
    const key = `${mediaType}:${remoteId}`;
    if (context.warnedParents.has(key)) return;
    context.warnedParents.add(key);
    log.warn(
        `peerId=${context.peerId} missing parent ${mediaType}=${remoteId}; ${action}`,
    );
}

function isMissingExportedParent(error: unknown): boolean {
    return error instanceof FederationHttpError && error.status === 404;
}

async function upsertArtist(
    context: SyncContext,
    item: ArtistEnvelope,
): Promise<void> {
    const existing = await prisma.artist.findUnique({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true, mbid: true },
    });
    const collision = await prisma.artist.findFirst({
        where: {
            mbid: item.attributes.mbid,
            NOT: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true },
    });
    const mbid =
        existing?.mbid ??
        (collision
            ? placeholderIdentity(context.peerId, item.attributes.mbid)
            : item.attributes.mbid);
    await prisma.artist.upsert({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        create: {
            peerId: context.peerId,
            remoteId: item.id,
            mbid,
            name: item.attributes.name,
            normalizedName: item.attributes.normalizedName,
            lastSynced: new Date(item.updatedAt),
        },
        update: {
            name: item.attributes.name,
            normalizedName: item.attributes.normalizedName,
            lastSynced: new Date(item.updatedAt),
        },
    });
}

async function loadRemoteArtistId(
    context: SyncContext,
    remoteId: string,
): Promise<string | null> {
    const artist = await prisma.artist.findUnique({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId },
        },
        select: { id: true },
    });
    return artist?.id ?? null;
}

async function ensureRemoteArtistId(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    remoteId: string,
    remember: boolean,
): Promise<string | null> {
    const existingId = await loadRemoteArtistId(context, remoteId);
    if (existingId) return existingId;
    if (context.unavailableParents.artist.has(remoteId)) {
        warnParentRecovery(context, "artist", remoteId, "skipping child");
        return null;
    }
    warnParentRecovery(context, "artist", remoteId, "fetching directly");
    let parent: FederationEnvelope;
    try {
        parent = await client.getCatalogItem("artist", remoteId);
    } catch (error) {
        if (!isMissingExportedParent(error)) throw error;
        context.unavailableParents.artist.add(remoteId);
        return null;
    }
    if (parent.mediaType !== "artist") {
        throw new Error("Federation host returned the wrong parent type");
    }
    await upsertArtist(context, parent);
    const importedId = await loadRemoteArtistId(context, remoteId);
    if (!importedId) throw new Error("Federation artist parent import failed");
    if (remember) rememberSeen(context, parent);
    return importedId;
}

async function upsertAlbum(
    context: SyncContext,
    item: AlbumEnvelope,
    client: ReturnType<typeof createFederationClient>,
    remember: boolean,
): Promise<boolean> {
    const artistId = await ensureRemoteArtistId(
        context,
        client,
        item.parentRef,
        remember,
    );
    if (!artistId) {
        context.unavailableParents.album.add(item.id);
        return false;
    }
    const existing = await prisma.album.findUnique({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true, rgMbid: true },
    });
    const collision = await prisma.album.findFirst({
        where: {
            rgMbid: item.attributes.rgMbid,
            NOT: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true },
    });
    const rgMbid =
        existing?.rgMbid ??
        (collision
            ? placeholderIdentity(context.peerId, item.attributes.rgMbid)
            : item.attributes.rgMbid);
    await prisma.album.upsert({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        create: {
            peerId: context.peerId,
            remoteId: item.id,
            artistId,
            rgMbid,
            title: item.attributes.title,
            year: item.attributes.year,
            primaryType: item.attributes.primaryType,
            location: "FEDERATED",
            lastSynced: new Date(item.updatedAt),
        },
        update: {
            artistId,
            title: item.attributes.title,
            year: item.attributes.year,
            primaryType: item.attributes.primaryType,
            lastSynced: new Date(item.updatedAt),
        },
    });
    context.albumRgMbids.set(item.id, item.attributes.rgMbid);
    return true;
}

async function loadRemoteAlbum(
    context: SyncContext,
    remoteId: string,
): Promise<{ id: string; rgMbid: string } | null> {
    const album = await prisma.album.findUnique({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId },
        },
        select: { id: true, rgMbid: true },
    });
    if (!album) return null;
    return {
        id: album.id,
        rgMbid:
            context.albumRgMbids.get(remoteId) ??
            decodeFederationIdentity(album.rgMbid),
    };
}

async function ensureRemoteAlbum(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    remoteId: string,
    remember: boolean,
): Promise<{ id: string; rgMbid: string } | null> {
    const existing = await loadRemoteAlbum(context, remoteId);
    if (existing) return existing;
    if (context.unavailableParents.album.has(remoteId)) {
        warnParentRecovery(context, "album", remoteId, "skipping child");
        return null;
    }
    warnParentRecovery(context, "album", remoteId, "fetching directly");
    let parent: FederationEnvelope;
    try {
        parent = await client.getCatalogItem("album", remoteId);
    } catch (error) {
        if (!isMissingExportedParent(error)) throw error;
        context.unavailableParents.album.add(remoteId);
        return null;
    }
    if (parent.mediaType !== "album") {
        throw new Error("Federation host returned the wrong parent type");
    }
    const applied = await upsertAlbum(context, parent, client, remember);
    if (!applied) return null;
    const imported = await loadRemoteAlbum(context, remoteId);
    if (!imported) throw new Error("Federation album parent import failed");
    if (remember) rememberSeen(context, parent);
    return imported;
}

async function findLocalDedupMatch(
    item: TrackEnvelope,
    albumRgMbid: string,
): Promise<{ id: string; confidence: number } | null> {
    const base = { origin: "LOCAL" as const, removedAt: null };
    const keys = [
        ["audioHash", item.attributes.audioHash, 1],
        ["recordingMbid", item.attributes.recordingMbid, 0.95],
        ["isrc", item.attributes.isrc, 0.9],
    ] as const;
    for (let index = 0; index < keys.length; index += 1) {
        const [field, value, confidence] = keys[index];
        if (!value) continue;
        const match = await prisma.track.findFirst({
            where: { ...base, [field]: value },
            orderBy: { id: "asc" },
            select: { id: true },
        });
        if (match) return { id: match.id, confidence };
    }
    const positional = await prisma.track.findFirst({
        where: {
            ...base,
            discNo: item.attributes.discNo,
            trackNo: item.attributes.trackNo,
            album: { rgMbid: albumRgMbid, location: "LIBRARY" },
        },
        orderBy: { id: "asc" },
        select: { id: true },
    });
    return positional ? { id: positional.id, confidence: 0.8 } : null;
}

async function applyTrackDedup(
    trackId: string,
    item: TrackEnvelope,
    albumRgMbid: string,
): Promise<void> {
    const match = await findLocalDedupMatch(item, albumRgMbid);
    await prisma.track.update({
        where: { id: trackId },
        data: { dedupOfTrackId: match?.id ?? null },
    });
    if (!match) return;
    await trackMappingService.createMapping({
        trackId: match.id,
        confidence: match.confidence,
        source: "federation",
    });
}

async function rebindFederatedTrack(
    context: SyncContext,
    item: TrackEnvelope,
    albumId: string,
): Promise<void> {
    const current = await prisma.track.findUnique({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true },
    });
    if (current) return;
    const attributes = item.attributes;
    const identity = [
        ...(attributes.audioHash ? [{ audioHash: attributes.audioHash }] : []),
        ...(attributes.recordingMbid
            ? [{ recordingMbid: attributes.recordingMbid }]
            : []),
        ...(attributes.isrc ? [{ isrc: attributes.isrc }] : []),
        {
            albumId,
            discNo: attributes.discNo,
            trackNo: attributes.trackNo,
        },
    ];
    const prior = await prisma.track.findFirst({
        where: {
            peerId: context.peerId,
            origin: "FEDERATED",
            removedAt: null,
            OR: identity,
        },
        orderBy: { id: "asc" },
        select: { id: true },
    });
    if (!prior) return;
    await prisma.track.update({
        where: { id: prior.id },
        data: { remoteId: item.id },
    });
}

async function upsertTrack(
    context: SyncContext,
    item: TrackEnvelope,
    client: ReturnType<typeof createFederationClient>,
    remember: boolean,
): Promise<boolean> {
    const album = await ensureRemoteAlbum(
        context,
        client,
        item.parentRef,
        remember,
    );
    if (!album) return false;
    const attributes = item.attributes;
    await rebindFederatedTrack(context, item, album.id);
    const row = await prisma.track.upsert({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        create: {
            peerId: context.peerId,
            remoteId: item.id,
            albumId: album.id,
            title: attributes.title,
            discNo: attributes.discNo,
            trackNo: attributes.trackNo,
            duration: attributes.duration,
            mime: attributes.mime,
            fileSize: attributes.fileSize,
            fileModified: new Date(item.updatedAt),
            recordingMbid: attributes.recordingMbid,
            isrc: attributes.isrc,
            audioHash: attributes.audioHash,
            origin: "FEDERATED",
            filePath: null,
            removedAt: null,
        },
        update: {
            albumId: album.id,
            title: attributes.title,
            discNo: attributes.discNo,
            trackNo: attributes.trackNo,
            duration: attributes.duration,
            mime: attributes.mime,
            fileSize: attributes.fileSize,
            fileModified: new Date(item.updatedAt),
            recordingMbid: attributes.recordingMbid,
            isrc: attributes.isrc,
            audioHash: attributes.audioHash,
            origin: "FEDERATED",
            filePath: null,
            removedAt: null,
        },
        select: { id: true },
    });
    await applyTrackDedup(row.id, item, album.rgMbid);
    if (attributes.embedding && context.scopes.includes("embeddings:read")) {
        await upsertTrackEmbedding(row.id, attributes.embedding);
    }
    return true;
}

async function applyEnvelope(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    item: FederationEnvelope,
    remember: boolean,
): Promise<void> {
    if (item.mediaType === "artist") await upsertArtist(context, item);
    else if (item.mediaType === "album") {
        if (!(await upsertAlbum(context, item, client, remember))) {
            context.skippedInvalid += 1;
            return;
        }
    } else if (!(await upsertTrack(context, item, client, remember))) {
        context.skippedInvalid += 1;
        return;
    }
    if (remember) rememberSeen(context, item);
    incrementCount(context, item.mediaType);
}

async function applyOrderedChanges(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    items: readonly FederationEnvelope[],
    remember: boolean,
): Promise<void> {
    const order: readonly MediaType[] = ["artist", "album", "track"];
    for (let typeIndex = 0; typeIndex < order.length; typeIndex += 1) {
        const type = order[typeIndex];
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if (item.mediaType === type) {
                await applyEnvelope(context, client, item, remember);
            }
        }
    }
}

async function syncFullType(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    mediaType: MediaType,
): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
        const result = await client.getCatalogItems(mediaType, cursor);
        context.skippedInvalid += result.skippedInvalid ?? 0;
        await applyOrderedChanges(context, client, result.items, true);
        if (!result.nextCursor) return;
        cursor = result.nextCursor;
    }
    throw new Error("Federation full sync exceeded the page bound");
}

type CleanupRow = { id: string; remoteId: string | null };
type CleanupLoader = (cursor?: string) => Promise<CleanupRow[]>;
type CleanupDelete = (ids: string[]) => Promise<unknown>;

async function cleanupUnseen(
    seen: ReadonlySet<string>,
    load: CleanupLoader,
    remove: CleanupDelete,
): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CLEANUP_PAGES; page += 1) {
        const rows = await load(cursor);
        if (rows.length === 0) return;
        const unseenIds = rows
            .filter((row) => !row.remoteId || !seen.has(row.remoteId))
            .map((row) => row.id);
        if (unseenIds.length > 0) await remove(unseenIds);
        cursor = rows[rows.length - 1].id;
    }
    throw new Error("Federation cleanup exceeded the page bound");
}

async function cleanupFullSync(context: SyncContext): Promise<void> {
    const query = (cursor?: string) => ({
        where: {
            peerId: context.peerId,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" as const },
        take: CLEANUP_BATCH_SIZE,
        select: { id: true, remoteId: true },
    });
    await cleanupUnseen(
        context.seen.track,
        (cursor) => prisma.track.findMany(query(cursor)),
        (ids) =>
            prisma.track.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
    await cleanupUnseen(
        context.seen.album,
        (cursor) => prisma.album.findMany(query(cursor)),
        (ids) =>
            prisma.album.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
    await cleanupUnseen(
        context.seen.artist,
        (cursor) => prisma.artist.findMany(query(cursor)),
        (ids) =>
            prisma.artist.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
}

async function applyTombstones(
    context: SyncContext,
    tombstones: readonly { entityType: MediaType; entityId: string }[],
): Promise<void> {
    const idsFor = (type: MediaType) =>
        tombstones
            .filter((item) => item.entityType === type)
            .map((item) => item.entityId);
    const trackIds = idsFor("track");
    const albumIds = idsFor("album");
    const artistIds = idsFor("artist");
    if (trackIds.length > 0) {
        await prisma.track.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: trackIds } },
        });
    }
    if (albumIds.length > 0) {
        await prisma.album.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: albumIds } },
        });
    }
    if (artistIds.length > 0) {
        await prisma.artist.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: artistIds } },
        });
    }
    context.counts.tombstones += tombstones.length;
}

async function finishSync(
    context: SyncContext,
    mode: FederationSyncResult["mode"],
    cursor: string,
    catalogEpoch: string,
): Promise<FederationSyncResult> {
    const changed =
        context.counts.artists +
        context.counts.albums +
        context.counts.tracks +
        context.counts.tombstones;
    if (changed > 0) await backfillAllArtistCounts();
    await prisma.federationPeer.update({
        where: { id: context.peerId },
        data: {
            lastSyncCursor: cursor,
            catalogEpoch,
            lastSeenAt: new Date(),
            status: "ACTIVE",
        },
    });
    log.info(
        `peerId=${context.peerId} mode=${mode} cursor=${cursor} artists=${context.counts.artists} albums=${context.counts.albums} tracks=${context.counts.tracks} tombstones=${context.counts.tombstones} skippedInvalid=${context.skippedInvalid}`,
    );
    return {
        mode,
        cursor,
        ...context.counts,
        skippedInvalid: context.skippedInvalid,
    };
}

function fullSyncCursor(manifest: FederationManifest, fallback: Date): string {
    if (manifest.serverTime) {
        const serverTime = new Date(manifest.serverTime);
        if (Number.isFinite(serverTime.getTime()))
            return serverTime.toISOString();
    }
    log.warn("Federation manifest lacks serverTime; using the local clock");
    return fallback.toISOString();
}

async function runFullSync(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    manifest: FederationManifest,
    startedAt: Date,
): Promise<FederationSyncResult> {
    const types: readonly MediaType[] = ["artist", "album", "track"];
    for (let index = 0; index < types.length; index += 1) {
        await syncFullType(context, client, types[index]);
    }
    await cleanupFullSync(context);
    return finishSync(
        context,
        "full",
        fullSyncCursor(manifest, startedAt),
        manifest.catalogEpoch,
    );
}

async function runIncrementalSync(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    cursor: string,
    catalogEpoch: string,
): Promise<FederationSyncResult> {
    const cursorDate = new Date(cursor);
    if (!Number.isFinite(cursorDate.getTime())) {
        throw new FederationEpochMismatchError(catalogEpoch);
    }
    const since = new Date(cursorDate.getTime() - OVERLAP_MS);
    let pageCursor: string | undefined;
    let nextSince = cursorDate;
    for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
        const result = await client.getCatalogDelta({
            since,
            epoch: catalogEpoch,
            cursor: pageCursor,
        });
        context.skippedInvalid += result.skippedInvalid ?? 0;
        await applyOrderedChanges(context, client, result.changes, false);
        await applyTombstones(context, result.tombstones);
        nextSince = new Date(result.nextSince);
        if (!result.nextCursor) {
            return finishSync(
                context,
                "incremental",
                nextSince.toISOString(),
                catalogEpoch,
            );
        }
        pageCursor = result.nextCursor;
    }
    throw new Error("Federation delta sync exceeded the page bound");
}

/** Runs one serialized, resumable full or incremental consumer-peer sync. */
export async function processFederationSync(
    job: Job<{ peerId: string }>,
): Promise<FederationSyncResult> {
    const data = jobDataSchema.parse(job.data);
    const peer = await prisma.federationPeer.findUnique({
        where: { id: data.peerId },
    });
    if (
        !peer ||
        !["CONSUMER", "BOTH"].includes(peer.direction) ||
        peer.status === "REVOKED" ||
        !peer.baseUrl ||
        !peer.outboundToken
    ) {
        throw new Error("Federation consumer peer is unavailable");
    }
    const startedAt = new Date();
    const client = createFederationClient(peer);
    const manifest = await client.getManifest();
    const context = newSyncContext(peer.id, peer.scopes);
    if (
        !peer.lastSyncCursor ||
        !peer.catalogEpoch ||
        peer.catalogEpoch !== manifest.catalogEpoch
    ) {
        return runFullSync(context, client, manifest, startedAt);
    }
    try {
        return await runIncrementalSync(
            context,
            client,
            peer.lastSyncCursor,
            peer.catalogEpoch,
        );
    } catch (error) {
        if (
            !(error instanceof FederationEpochMismatchError) &&
            !(error instanceof FederationStaleCursorError)
        ) {
            throw error;
        }
        await prisma.federationPeer.update({
            where: { id: peer.id },
            data: { lastSyncCursor: null, catalogEpoch: error.currentEpoch },
        });
        const refreshedManifest = await client.getManifest();
        return runFullSync(context, client, refreshedManifest, startedAt);
    }
}
