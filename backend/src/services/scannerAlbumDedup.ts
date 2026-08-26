import { Prisma } from "@prisma/client";
import { normalizeForExactKey } from "../utils/artistNormalization";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    promoteAlbumLocation,
    selectPreferredAlbumOwnershipSource,
} from "./albumOwnershipPromotion";
import { recomputeAlbumLoudness } from "./albumLoudness";
import { selectPreferredScannerAlbumCandidate } from "./scannerAlbumIdentityPolicy";

const dedupLogger = logger.child("ScannerAlbumDedup");
const SCANNER_ALBUM_DEDUP_BATCH_SIZE = 100;
const SCANNER_ALBUM_DEDUP_MAX_SCAN_BATCHES = 100;
const SCANNER_ALBUM_DEDUP_TRANSACTION_OPTIONS = {
    maxWait: 2_000,
    timeout: 15_000,
} as const;

/** Maximum normalized duplicate-title groups processed in one maintenance run. */
export const SCANNER_ALBUM_DEDUP_MAX_GROUPS = 200;
/** Maximum total Track rows reparented by one duplicate group transaction. */
export const SCANNER_ALBUM_DEDUP_MAX_TRACK_ROWS = 2_000;

/** Album identity fields used during bounded duplicate discovery. */
export interface ScannerAlbumIdentityCandidate {
    artistId: string;
    hasUserOverrides: boolean;
    id: string;
    location: string;
    rgMbid: string;
    title: string;
}

/** Album state used by scanner keeper selection. */
export interface ScannerAlbumDedupCandidate extends ScannerAlbumIdentityCandidate {
    activeTrackCount: number;
}

/** Same-artist albums sharing one normalized scanner title identity. */
export interface ScannerAlbumDuplicateGroup {
    albums: ScannerAlbumIdentityCandidate[];
    key: string;
}

/** Keeper and temporary losers selected for one duplicate group. */
export interface ScannerAlbumMergePlan {
    keeper: ScannerAlbumDedupCandidate;
    losers: ScannerAlbumDedupCandidate[];
}

/** Structured outcome of one bounded scanner album deduplication run. */
export interface ScannerAlbumDedupResult {
    affectedArtistIds: string[];
    albumsDeferredByBatchCap: number;
    failed: number;
    groupsDeferredByCap: number;
    groupsFound: number;
    merged: number;
    skippedBothReal: number;
    skippedNoActiveLocalTracks: number;
    skippedNoDirOverlap: number;
    skippedNullActiveLocalPath: number;
    skippedRevalidation: number;
    skippedTrackLimit: number;
    skippedUnsafeReferences: number;
    skippedUserOverrides: number;
}

function isTemporaryAlbum(candidate: { rgMbid: string }): boolean {
    return candidate.rgMbid.startsWith("temp-");
}

function duplicateKey(candidate: ScannerAlbumIdentityCandidate): string {
    return `${candidate.artistId}\u0000${normalizeForExactKey(candidate.title)}`;
}

function findDuplicateGroups(
    candidates: readonly ScannerAlbumIdentityCandidate[],
): ScannerAlbumDuplicateGroup[] {
    const grouped = new Map<string, ScannerAlbumIdentityCandidate[]>();
    const ordered = [...candidates].sort((left, right) =>
        left.id.localeCompare(right.id),
    );
    for (const candidate of ordered) {
        const key = duplicateKey(candidate);
        const albums = grouped.get(key) ?? [];
        albums.push(candidate);
        grouped.set(key, albums);
    }
    return [...grouped.entries()]
        .filter(
            ([, albums]) => albums.length > 1 && albums.some(isTemporaryAlbum),
        )
        .map(([key, albums]) => ({ key, albums }));
}

/** Groups eligible scanner albums by artist and exact normalized title. */
export function groupScannerAlbumDuplicates(
    candidates: readonly ScannerAlbumIdentityCandidate[],
): ScannerAlbumDuplicateGroup[] {
    return findDuplicateGroups(candidates).slice(
        0,
        SCANNER_ALBUM_DEDUP_MAX_GROUPS,
    );
}

/** Selects a keeper without ever treating a real release group as a loser. */
export function selectScannerAlbumKeeper(
    albums: readonly ScannerAlbumDedupCandidate[],
): ScannerAlbumMergePlan | null {
    if (albums.length < 2) return null;
    const realAlbums = albums.filter((album) => !isTemporaryAlbum(album));
    if (realAlbums.length > 1) return null;
    // A real release-group identity is never made a loser. Location preference
    // applies to all-temporary groups and scanner lookup candidate selection.
    const keeper =
        realAlbums.length === 1
            ? realAlbums[0]
            : selectPreferredScannerAlbumCandidate(albums);
    if (!keeper) return null;
    const losers = albums.filter(
        (album) => album.id !== keeper.id && isTemporaryAlbum(album),
    );
    return losers.length > 0 ? { keeper, losers } : null;
}

function parentDirectory(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const separator = normalized.lastIndexOf("/");
    return separator < 0 ? "." : normalized.slice(0, separator);
}

function trackDirectories(paths: readonly (string | null)[]): Set<string> {
    return new Set(
        paths.flatMap((filePath) =>
            filePath === null ? [] : [parentDirectory(filePath)],
        ),
    );
}

/** Returns whether every loser directory is already occupied by the keeper. */
export function trackDirectoriesOverlap(
    keeperPaths: readonly (string | null)[],
    loserPaths: readonly (string | null)[],
): boolean {
    const keeperDirectories = trackDirectories(keeperPaths);
    const loserDirectories = trackDirectories(loserPaths);
    return [...loserDirectories].every((directory) =>
        keeperDirectories.has(directory),
    );
}

interface DedupDiscovery {
    albumsDeferredByBatchCap: number;
    candidates: ScannerAlbumIdentityCandidate[];
}

function discoveryWhere(afterId: string | undefined): Prisma.AlbumWhereInput {
    return {
        ...(afterId ? { id: { gt: afterId } } : {}),
        location: { in: ["LIBRARY", "DISCOVER"] },
    };
}

async function loadDedupCandidates(): Promise<DedupDiscovery> {
    const candidates: ScannerAlbumIdentityCandidate[] = [];
    let afterId: string | undefined;
    let reachedBatchCap = false;
    for (
        let batch = 0;
        batch < SCANNER_ALBUM_DEDUP_MAX_SCAN_BATCHES;
        batch += 1
    ) {
        const rows = await prisma.album.findMany({
            where: discoveryWhere(afterId),
            orderBy: { id: "asc" },
            take: SCANNER_ALBUM_DEDUP_BATCH_SIZE,
            select: {
                id: true,
                artistId: true,
                hasUserOverrides: true,
                location: true,
                title: true,
                rgMbid: true,
            },
        });
        candidates.push(...rows);
        afterId = rows.at(-1)?.id ?? afterId;
        if (rows.length < SCANNER_ALBUM_DEDUP_BATCH_SIZE) break;
        reachedBatchCap = batch + 1 === SCANNER_ALBUM_DEDUP_MAX_SCAN_BATCHES;
    }
    const albumsDeferredByBatchCap =
        reachedBatchCap && afterId
            ? await prisma.album.count({ where: discoveryWhere(afterId) })
            : 0;
    return { albumsDeferredByBatchCap, candidates };
}

type MergeEvent = Readonly<{
    artistId: string;
    keeperId: string;
    loserId: string;
    referencesReparented: number;
    tracksReparented: number;
}>;

interface GroupMergeResult {
    merged: MergeEvent[];
    skippedBothReal: number;
    skippedNoActiveLocalTracks: number;
    skippedNoDirOverlap: number;
    skippedNullActiveLocalPath: number;
    skippedRevalidation: number;
    skippedTrackLimit: number;
    skippedUnsafeReferences: number;
    skippedUserOverrides: number;
}

function emptyGroupResult(): GroupMergeResult {
    return {
        merged: [],
        skippedBothReal: 0,
        skippedNoActiveLocalTracks: 0,
        skippedNoDirOverlap: 0,
        skippedNullActiveLocalPath: 0,
        skippedRevalidation: 0,
        skippedTrackLimit: 0,
        skippedUnsafeReferences: 0,
        skippedUserOverrides: 0,
    };
}

async function lockAndReloadGroup(
    transaction: Prisma.TransactionClient,
    group: ScannerAlbumDuplicateGroup,
): Promise<ScannerAlbumIdentityCandidate[]> {
    const ids = group.albums.map((album) => album.id);
    const lockedRows = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
        SELECT "id"
        FROM "Album"
        WHERE "id" IN (${Prisma.join(ids)})
        ORDER BY "id"
        FOR UPDATE
    `,
    );
    const lockedIds = lockedRows.map((row) => row.id);
    if (lockedIds.length !== ids.length) return [];
    return transaction.album.findMany({
        where: { id: { in: lockedIds } },
        orderBy: { id: "asc" },
        select: {
            id: true,
            artistId: true,
            hasUserOverrides: true,
            location: true,
            title: true,
            rgMbid: true,
        },
    });
}

function isRevalidatedGroup(
    group: ScannerAlbumDuplicateGroup,
    albums: readonly ScannerAlbumIdentityCandidate[],
): boolean {
    if (albums.length !== group.albums.length) return false;
    const keys = new Set(albums.map(duplicateKey));
    return keys.size === 1 && keys.has(group.key);
}

interface LockedTrack {
    albumId: string;
    filePath: string | null;
    id: string;
    origin: string;
    removedAt: Date | null;
}

async function lockTrackIds(
    transaction: Prisma.TransactionClient,
    trackIds: readonly string[],
): Promise<string[]> {
    if (trackIds.length === 0) return [];
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "Track"
        WHERE "id" IN (${Prisma.join(trackIds)})
        ORDER BY "id"
        FOR UPDATE
    `);
    return rows.map((row) => row.id);
}

async function loadCandidateTrackIds(
    transaction: Prisma.TransactionClient,
    albumIds: readonly string[],
): Promise<string[]> {
    const rows = await transaction.track.findMany({
        where: { albumId: { in: [...albumIds] } },
        orderBy: { id: "asc" },
        take: SCANNER_ALBUM_DEDUP_MAX_TRACK_ROWS + 1,
        select: { id: true },
    });
    return rows.map((row) => row.id);
}

async function reloadLockedTracks(
    transaction: Prisma.TransactionClient,
    trackIds: readonly string[],
): Promise<LockedTrack[]> {
    if (trackIds.length === 0) return [];
    return transaction.track.findMany({
        where: { id: { in: [...trackIds] } },
        orderBy: { id: "asc" },
        select: {
            albumId: true,
            filePath: true,
            id: true,
            origin: true,
            removedAt: true,
        },
    });
}

function activeLocalTracks(tracks: readonly LockedTrack[]): LockedTrack[] {
    return tracks.filter(
        (track) => track.origin === "LOCAL" && track.removedAt === null,
    );
}

function hydrateActiveCounts(
    albums: readonly ScannerAlbumIdentityCandidate[],
    tracks: readonly LockedTrack[],
): ScannerAlbumDedupCandidate[] {
    const counts = new Map<string, number>();
    for (const track of tracks) {
        if (track.removedAt !== null) continue;
        counts.set(track.albumId, (counts.get(track.albumId) ?? 0) + 1);
    }
    return albums.map((album) => ({
        ...album,
        activeTrackCount: counts.get(album.id) ?? 0,
    }));
}

function pathsByAlbum(
    tracks: readonly LockedTrack[],
): Map<string, (string | null)[]> {
    const paths = new Map<string, (string | null)[]>();
    for (const track of tracks) {
        const albumPaths = paths.get(track.albumId) ?? [];
        albumPaths.push(track.filePath);
        paths.set(track.albumId, albumPaths);
    }
    return paths;
}

async function hasUnsafeOwnedAlbumReferences(
    transaction: Prisma.TransactionClient,
    plan: ScannerAlbumMergePlan,
): Promise<boolean> {
    const loserByRgMbid = new Map(
        plan.losers.map((loser) => [loser.rgMbid, loser]),
    );
    const rows = await transaction.ownedAlbum.findMany({
        where: { rgMbid: { in: [...loserByRgMbid.keys()] } },
        select: { artistId: true, rgMbid: true },
    });
    return rows.some((row) => {
        const loser = loserByRgMbid.get(row.rgMbid);
        return !loser || row.artistId !== loser.artistId;
    });
}

async function repointOwnedAlbum(
    transaction: Prisma.TransactionClient,
    keeper: ScannerAlbumDedupCandidate,
    loser: ScannerAlbumDedupCandidate,
): Promise<number> {
    const key = {
        artistId_rgMbid: {
            artistId: keeper.artistId,
            rgMbid: keeper.rgMbid,
        },
    };
    const [keeperOwnership, loserOwnership] = await Promise.all([
        transaction.ownedAlbum.findUnique({ where: key }),
        transaction.ownedAlbum.findUnique({
            where: {
                artistId_rgMbid: {
                    artistId: loser.artistId,
                    rgMbid: loser.rgMbid,
                },
            },
        }),
    ]);
    if (loserOwnership) {
        const source = selectPreferredAlbumOwnershipSource(
            keeperOwnership?.source,
            loserOwnership.source,
        );
        await transaction.ownedAlbum.upsert({
            where: key,
            create: {
                artistId: keeper.artistId,
                rgMbid: keeper.rgMbid,
                source,
            },
            update: { source },
        });
    }
    const deleted = await transaction.ownedAlbum.deleteMany({
        where: { rgMbid: loser.rgMbid },
    });
    return deleted.count;
}

async function repointAlbumIdReferences(
    transaction: Prisma.TransactionClient,
    keeperId: string,
    loserId: string,
): Promise<number> {
    // schema.prisma has exactly three non-Track albumId relations. All are
    // identity links, so they safely follow the canonical keeper.
    const discovery = await transaction.discoveryAlbum.updateMany({
        where: { catalogAlbumId: loserId },
        data: { catalogAlbumId: keeperId },
    });
    const tidal = await transaction.trackTidal.updateMany({
        where: { albumId: loserId },
        data: { albumId: keeperId },
    });
    const ytMusic = await transaction.trackYtMusic.updateMany({
        where: { albumId: loserId },
        data: { albumId: keeperId },
    });
    return discovery.count + tidal.count + ytMusic.count;
}

async function mergeLoser(
    transaction: Prisma.TransactionClient,
    keeper: ScannerAlbumDedupCandidate,
    loser: ScannerAlbumDedupCandidate,
    loserTrackIds: readonly string[],
): Promise<MergeEvent> {
    const ownedAlbums = await repointOwnedAlbum(transaction, keeper, loser);
    const albumIdReferences = await repointAlbumIdReferences(
        transaction,
        keeper.id,
        loser.id,
    );
    const updated = await transaction.track.updateMany({
        // Tracks added after the locked evidence read stay on the loser. That
        // keeps it non-orphaned, and the next maintenance run re-evaluates it.
        where: { id: { in: [...loserTrackIds] } },
        data: { albumId: keeper.id },
    });
    return {
        artistId: keeper.artistId,
        keeperId: keeper.id,
        loserId: loser.id,
        referencesReparented: ownedAlbums + albumIdReferences,
        tracksReparented: updated.count,
    };
}

function skippedPlanResult(
    albums: readonly ScannerAlbumIdentityCandidate[],
): GroupMergeResult {
    const result = emptyGroupResult();
    const realCount = albums.filter((album) => !isTemporaryAlbum(album)).length;
    if (realCount > 1) result.skippedBothReal = 1;
    else result.skippedRevalidation = 1;
    return result;
}

async function protectedGroupSkip(
    transaction: Prisma.TransactionClient,
    plan: ScannerAlbumMergePlan,
): Promise<GroupMergeResult | null> {
    const result = emptyGroupResult();
    if (plan.losers.some((loser) => loser.hasUserOverrides)) {
        result.skippedUserOverrides = 1;
        dedupLogger.debug(
            "Skipped scanner album duplicate group with loser user overrides",
            { groupKey: duplicateKey(plan.keeper) },
        );
        return result;
    }
    if (!(await hasUnsafeOwnedAlbumReferences(transaction, plan))) return null;
    result.skippedUnsafeReferences = 1;
    dedupLogger.debug(
        "Skipped scanner album duplicate group with unsafe ownership references",
        { groupKey: duplicateKey(plan.keeper) },
    );
    return result;
}

function hasNullPathLoser(
    plan: ScannerAlbumMergePlan,
    activeTracks: readonly LockedTrack[],
): boolean {
    const loserIds = new Set(plan.losers.map((loser) => loser.id));
    return activeTracks.some(
        (track) => loserIds.has(track.albumId) && track.filePath === null,
    );
}

function mergeableLosers(
    plan: ScannerAlbumMergePlan,
    activeTracks: readonly LockedTrack[],
    result: GroupMergeResult,
): ScannerAlbumDedupCandidate[] {
    const paths = pathsByAlbum(activeTracks);
    const keeperPaths = paths.get(plan.keeper.id) ?? [];
    return plan.losers.filter((loser) => {
        const loserPaths = (paths.get(loser.id) ?? []).filter(
            (filePath): filePath is string => filePath !== null,
        );
        if (loserPaths.length === 0) {
            result.skippedNoActiveLocalTracks += 1;
            dedupLogger.debug(
                "Skipped scanner album duplicate without active local loser tracks",
                { keeperId: plan.keeper.id, loserId: loser.id },
            );
            return false;
        }
        if (trackDirectoriesOverlap(keeperPaths, loserPaths)) return true;
        result.skippedNoDirOverlap += 1;
        dedupLogger.debug(
            "Skipped scanner album duplicate outside keeper directories",
            { keeperId: plan.keeper.id, loserId: loser.id },
        );
        return false;
    });
}

function trackIdsByAlbum(
    tracks: readonly LockedTrack[],
): Map<string, string[]> {
    const trackIds = new Map<string, string[]>();
    for (const track of tracks) {
        const albumTrackIds = trackIds.get(track.albumId) ?? [];
        albumTrackIds.push(track.id);
        trackIds.set(track.albumId, albumTrackIds);
    }
    return trackIds;
}

async function promoteKeeperForLibraryLoser(
    transaction: Prisma.TransactionClient,
    keeper: ScannerAlbumDedupCandidate,
    losers: readonly ScannerAlbumDedupCandidate[],
): Promise<void> {
    if (
        keeper.location !== "LIBRARY" &&
        losers.some((loser) => loser.location === "LIBRARY")
    ) {
        await promoteAlbumLocation(transaction, keeper.id);
    }
}

async function mergeValidatedGroup(
    transaction: Prisma.TransactionClient,
    plan: ScannerAlbumMergePlan,
    lockedTracks: readonly LockedTrack[],
): Promise<GroupMergeResult> {
    const result = emptyGroupResult();
    const protectedSkip = await protectedGroupSkip(transaction, plan);
    if (protectedSkip) return protectedSkip;
    const activeTracks = activeLocalTracks(lockedTracks);
    if (hasNullPathLoser(plan, activeTracks)) {
        result.skippedNullActiveLocalPath = 1;
        dedupLogger.debug(
            "Skipped scanner album duplicate group with null-path active local loser tracks",
            { groupKey: duplicateKey(plan.keeper) },
        );
        return result;
    }
    const losers = mergeableLosers(plan, activeTracks, result);
    await promoteKeeperForLibraryLoser(transaction, plan.keeper, losers);
    const trackIds = trackIdsByAlbum(lockedTracks);
    for (const loser of losers) {
        result.merged.push(
            await mergeLoser(
                transaction,
                plan.keeper,
                loser,
                trackIds.get(loser.id) ?? [],
            ),
        );
    }
    if (result.merged.length > 0) {
        await recomputeAlbumLoudness(transaction, [plan.keeper.id]);
    }
    return result;
}

async function mergeLockedGroup(
    transaction: Prisma.TransactionClient,
    group: ScannerAlbumDuplicateGroup,
): Promise<GroupMergeResult> {
    const albumIds = group.albums.map((album) => album.id);
    const candidateTrackIds = await loadCandidateTrackIds(
        transaction,
        albumIds,
    );
    if (candidateTrackIds.length > SCANNER_ALBUM_DEDUP_MAX_TRACK_ROWS) {
        const result = emptyGroupResult();
        result.skippedTrackLimit = 1;
        return result;
    }
    // Match scanner persistence's Track -> Album lock order. The unlocked
    // candidate set is re-read after both row sets are locked before any write.
    const lockedTrackIds = await lockTrackIds(transaction, candidateTrackIds);
    const albums = await lockAndReloadGroup(transaction, group);
    if (!isRevalidatedGroup(group, albums)) {
        const result = emptyGroupResult();
        result.skippedRevalidation = 1;
        return result;
    }
    const lockedTracks = await reloadLockedTracks(transaction, lockedTrackIds);
    if (lockedTracks.length !== lockedTrackIds.length) {
        const result = emptyGroupResult();
        result.skippedRevalidation = 1;
        return result;
    }
    const revalidatedAlbumIds = new Set(albums.map((album) => album.id));
    const groupTracks = lockedTracks.filter((track) =>
        revalidatedAlbumIds.has(track.albumId),
    );
    const plan = selectScannerAlbumKeeper(
        hydrateActiveCounts(albums, groupTracks),
    );
    if (!plan) return skippedPlanResult(albums);
    return mergeValidatedGroup(transaction, plan, groupTracks);
}

async function mergeGroup(
    group: ScannerAlbumDuplicateGroup,
): Promise<GroupMergeResult> {
    return prisma.$transaction(
        (transaction) => mergeLockedGroup(transaction, group),
        SCANNER_ALBUM_DEDUP_TRANSACTION_OPTIONS,
    );
}

function addGroupResult(
    result: ScannerAlbumDedupResult,
    groupResult: GroupMergeResult,
): void {
    result.merged += groupResult.merged.length;
    result.skippedBothReal += groupResult.skippedBothReal;
    result.skippedNoActiveLocalTracks += groupResult.skippedNoActiveLocalTracks;
    result.skippedNoDirOverlap += groupResult.skippedNoDirOverlap;
    result.skippedNullActiveLocalPath += groupResult.skippedNullActiveLocalPath;
    result.skippedRevalidation += groupResult.skippedRevalidation;
    result.skippedTrackLimit += groupResult.skippedTrackLimit;
    result.skippedUnsafeReferences += groupResult.skippedUnsafeReferences;
    result.skippedUserOverrides += groupResult.skippedUserOverrides;
    result.affectedArtistIds = [
        ...new Set([
            ...result.affectedArtistIds,
            ...groupResult.merged.map((event) => event.artistId),
        ]),
    ].sort();
}

function initialResult(
    groupsFound: number,
    groupsDeferredByCap: number,
    albumsDeferredByBatchCap: number,
): ScannerAlbumDedupResult {
    return {
        affectedArtistIds: [],
        albumsDeferredByBatchCap,
        failed: 0,
        groupsDeferredByCap,
        groupsFound,
        merged: 0,
        skippedBothReal: 0,
        skippedNoActiveLocalTracks: 0,
        skippedNoDirOverlap: 0,
        skippedNullActiveLocalPath: 0,
        skippedRevalidation: 0,
        skippedTrackLimit: 0,
        skippedUnsafeReferences: 0,
        skippedUserOverrides: 0,
    };
}

/** Merges bounded scanner-created duplicate album rows before orphan cleanup. */
export async function deduplicateScannerAlbums(): Promise<ScannerAlbumDedupResult> {
    const discovery = await loadDedupCandidates();
    const foundGroups = findDuplicateGroups(discovery.candidates);
    const groups = foundGroups.slice(0, SCANNER_ALBUM_DEDUP_MAX_GROUPS);
    const result = initialResult(
        foundGroups.length,
        foundGroups.length - groups.length,
        discovery.albumsDeferredByBatchCap,
    );
    for (const group of groups) {
        try {
            const groupResult = await mergeGroup(group);
            addGroupResult(result, groupResult);
            for (const event of groupResult.merged) {
                dedupLogger.debug("Merged scanner album duplicate", event);
            }
        } catch (error: unknown) {
            result.failed += 1;
            dedupLogger.error("Scanner album duplicate group failed", {
                error,
                groupKey: group.key,
            });
        }
    }
    dedupLogger.info("Scanner album deduplication complete", result);
    return result;
}
