/**
 * Listen Together service layer.
 *
 * Handles the "cold path": CRUD via Prisma, discovery, and periodic
 * persistence of in-memory state to PostgreSQL.  Delegates all real-time
 * playback operations to the in-memory GroupManager.
 */

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";
import { logger } from "../utils/logger";
import { trackMappingService } from "./trackMappingService";
import {
    groupManager,
    MAX_QUEUE_SIZE,
    type SyncQueueItem,
    type GroupSnapshot,
    type GroupState,
    type PersistedGroupMember,
    GroupError,
} from "./listenTogetherManager";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import { withGroupMutationLock } from "./listenTogetherMutationLock";
import {
    enqueueGroupSnapshotPublication,
    flushGroupPublications,
    type PublicationExecutionOptions,
} from "./listenTogetherCallbacks";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { withSyncGroupMembershipFence } from "./listenTogetherMembershipFence";
import { endGroupInDb } from "./listenTogetherGroupEnding";
import {
    commitGroupDeparture,
    loadPersistedMemberships,
    type CommittedDeparture,
} from "./listenTogetherGroupDeparture";
import {
    assertUserNotPendingDeletion,
    requireMembershipEligibleUser,
} from "./listenTogetherUserEligibility";
import {
    withListenTogetherMutationAdmission,
    withListenTogetherShutdownMutationAdmission,
} from "./listenTogetherMutationAdmission";
import {
    captureGroupPublicationBase,
    applyCommittedReconnect,
    publishCommittedDeparture,
    publishCommittedEnd,
    publishCommittedJoin,
} from "./listenTogetherMembershipPublication";
import {
    normalizeCanonicalMediaProviderIdentity,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const JOIN_CODE_LENGTH = 6;
const JOIN_CODE_MAX_ATTEMPTS = 12;
const PERSIST_INTERVAL_MS = 30_000; // Persist dirty groups every 30s
const MAX_PERSIST_GROUPS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateGroupOptions {
    name?: string;
    visibility?: "public" | "private";
    queueTrackIds?: string[];
    queueTracks?: QueueTrackInput[];
    currentTrackId?: string;
    currentTimeMs?: number;
    isPlaying?: boolean;
}

export interface DiscoverableGroup {
    id: string;
    name: string;
    joinCode: string;
    groupType: "host-follower";
    visibility: "public" | "private";
    host: { id: string; username: string };
    memberCount: number;
    isMember: boolean;
    isPlaying: boolean;
    currentTrack: { id: string; title: string; artistName: string } | null;
}

export interface LeaveResult {
    ended: boolean;
    newHostUserId?: string;
    newHostUsername?: string;
}

export interface QueueTrackInput {
    trackId?: string;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    thumbnailUrl?: string;
    isrc?: string;
}

interface CommittedJoin {
    hostUserId: string;
    memberships: PersistedGroupMember[];
    membershipTransitioned: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeJoinCode(input: string): string {
    return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function generateJoinCode(): Promise<string> {
    for (let attempt = 0; attempt < JOIN_CODE_MAX_ATTEMPTS; attempt++) {
        let candidate = "";
        for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
            candidate +=
                JOIN_CODE_ALPHABET[
                    crypto.randomInt(0, JOIN_CODE_ALPHABET.length)
                ];
        }
        const existing = await prisma.syncGroup.findUnique({
            where: { joinCode: candidate },
            select: { id: true },
        });
        if (!existing) return candidate;
    }
    throw new Error("Failed to generate a unique join code");
}

async function resolvePresentationName(
    userId: string,
    fallbackUsername: string,
): Promise<string> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, displayName: true },
    });
    const trimmedDisplayName = user?.displayName?.trim();
    if (trimmedDisplayName) {
        return trimmedDisplayName;
    }
    return user?.username ?? fallbackUsername;
}

async function loadLocalQueueMappingIds(
    trackIds: string[],
): Promise<Map<string, string>> {
    const mappings = await prisma.trackMapping.findMany({
        where: { stale: false, trackId: { in: trackIds } },
        select: { id: true, trackId: true },
        orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
    });
    const mappingByTrackId = new Map<string, string>();
    for (const mapping of mappings) {
        if (mapping.trackId && !mappingByTrackId.has(mapping.trackId)) {
            mappingByTrackId.set(mapping.trackId, mapping.id);
        }
    }
    return mappingByTrackId;
}

/**
 * Validates and materializes mixed-source queue input into canonical queue items.
 */
export async function validateQueueTracks(
    inputs: QueueTrackInput[],
): Promise<SyncQueueItem[]> {
    if (!inputs.length) return [];

    const localInputs: Array<{ input: QueueTrackInput; trackId: string }> = [];
    const tidalInputs: Array<{ input: QueueTrackInput; tidalTrackId: number }> =
        [];
    const youtubeInputs: Array<{
        input: QueueTrackInput;
        youtubeVideoId: string;
    }> = [];

    for (const input of inputs) {
        const localTrackId =
            typeof input.trackId === "string" && input.trackId.trim().length > 0
                ? input.trackId.trim()
                : null;
        const tidalTrackId =
            typeof input.tidalTrackId === "number" &&
            Number.isFinite(input.tidalTrackId) &&
            input.tidalTrackId > 0
                ? Math.trunc(input.tidalTrackId)
                : null;
        const youtubeVideoId =
            typeof input.youtubeVideoId === "string" &&
            input.youtubeVideoId.trim().length > 0
                ? input.youtubeVideoId.trim()
                : null;
        const presentCount = [
            localTrackId,
            tidalTrackId,
            youtubeVideoId,
        ].filter(Boolean).length;
        if (presentCount !== 1) continue;

        if (localTrackId) {
            localInputs.push({ input, trackId: localTrackId });
            continue;
        }
        if (tidalTrackId) {
            tidalInputs.push({ input, tidalTrackId });
            continue;
        }
        if (youtubeVideoId) {
            youtubeInputs.push({ input, youtubeVideoId });
        }
    }

    const queue: SyncQueueItem[] = [];

    if (localInputs.length > 0) {
        const uniqueLocalIds = Array.from(
            new Set(localInputs.map((entry) => entry.trackId)),
        );
        const localTracks = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                id: { in: uniqueLocalIds },
            },
            select: {
                id: true,
                title: true,
                duration: true,
                filePath: true,
                origin: true,
                loudnessLufs: true,
                truePeakDb: true,
                federationPeer: {
                    select: { outboundStatus: true },
                },
                album: {
                    select: {
                        id: true,
                        title: true,
                        coverUrl: true,
                        albumLoudnessLufs: true,
                        albumTruePeakDb: true,
                        artist: { select: { id: true, name: true } },
                    },
                },
            },
        });
        const localMappingIds = await loadLocalQueueMappingIds(uniqueLocalIds);
        const localTrackMap = new Map(
            localTracks.map((track) => [track.id, track]),
        );

        for (const entry of localInputs) {
            const track = localTrackMap.get(entry.trackId);
            if (!track) continue;
            const isPeer = track.origin === "FEDERATED";
            queue.push({
                id: track.id,
                title: track.title,
                duration: track.duration,
                loudnessLufs: track.loudnessLufs,
                truePeakDb: track.truePeakDb,
                artist: {
                    id: track.album.artist.id,
                    name: track.album.artist.name,
                },
                album: {
                    id: track.album.id,
                    title: track.album.title,
                    coverArt: track.album.coverUrl,
                    albumLoudnessLufs: track.album.albumLoudnessLufs,
                    albumTruePeakDb: track.album.albumTruePeakDb,
                },
                mediaSource: isPeer ? "peer" : "local",
                provider: { source: isPeer ? "peer" : "local" },
                localTrackId: track.id,
                trackMappingId: localMappingIds.get(track.id),
                originSource: isPeer ? "peer" : "local",
                peerOnline: isPeer
                    ? track.federationPeer?.outboundStatus === "ACTIVE"
                    : undefined,
            });
        }
    }

    for (const entry of tidalInputs) {
        const title = (entry.input.title ?? "").trim();
        const artist = (entry.input.artist ?? "").trim();
        const album = (entry.input.album ?? "").trim();
        const duration =
            typeof entry.input.duration === "number" &&
            Number.isFinite(entry.input.duration)
                ? Math.max(1, Math.trunc(entry.input.duration))
                : 180;
        const ensured = await trackMappingService.ensureRemoteTrack({
            provider: "tidal",
            tidalId: entry.tidalTrackId,
            title: title || "Unknown Track",
            artist: artist || "Unknown Artist",
            album: album || "Unknown Album",
            duration,
            isrc: entry.input.isrc,
        });
        const mapping = await prisma.trackMapping.findFirst({
            where: { trackTidalId: ensured.id, stale: false },
            select: { id: true },
            orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
        });

        queue.push({
            id: `tidal:${entry.tidalTrackId}`,
            title: title || "Unknown Track",
            duration,
            artist: {
                id: `tidal-artist:${entry.tidalTrackId}`,
                name: artist || "Unknown Artist",
            },
            album: {
                id: `tidal-album:${entry.tidalTrackId}`,
                title: album || "Unknown Album",
                coverArt: null,
            },
            mediaSource: "tidal",
            provider: {
                source: "tidal",
                providerTrackId: String(entry.tidalTrackId),
                tidalTrackId: entry.tidalTrackId,
            },
            streamSource: "tidal",
            tidalTrackId: entry.tidalTrackId,
            trackTidalId: ensured.id,
            trackMappingId: mapping?.id,
            originSource: "tidal",
        });
    }

    for (const entry of youtubeInputs) {
        const title = (entry.input.title ?? "").trim();
        const artist = (entry.input.artist ?? "").trim();
        const album = (entry.input.album ?? "").trim();
        const duration =
            typeof entry.input.duration === "number" &&
            Number.isFinite(entry.input.duration)
                ? Math.max(1, Math.trunc(entry.input.duration))
                : 180;
        const ensured = await trackMappingService.ensureRemoteTrack({
            provider: "youtube",
            videoId: entry.youtubeVideoId,
            title: title || "Unknown Track",
            artist: artist || "Unknown Artist",
            album: album || "Unknown Album",
            duration,
            thumbnailUrl: entry.input.thumbnailUrl,
        });
        const mapping = await prisma.trackMapping.findFirst({
            where: { trackYtMusicId: ensured.id, stale: false },
            select: { id: true },
            orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
        });

        queue.push({
            id: `yt:${entry.youtubeVideoId}`,
            title: title || "Unknown Track",
            duration,
            artist: {
                id: `yt-artist:${entry.youtubeVideoId}`,
                name: artist || "Unknown Artist",
            },
            album: {
                id: `yt-album:${entry.youtubeVideoId}`,
                title: album || "Unknown Album",
                coverArt: entry.input.thumbnailUrl ?? null,
            },
            mediaSource: "youtube",
            provider: {
                source: "youtube",
                providerTrackId: entry.youtubeVideoId,
                youtubeVideoId: entry.youtubeVideoId,
            },
            streamSource: "youtube",
            youtubeVideoId: entry.youtubeVideoId,
            trackYtMusicId: ensured.id,
            trackMappingId: mapping?.id,
            originSource: "youtube",
        });
    }

    return queue;
}

/** Backward-compatible local-only wrapper used by older paths/tests. */
export async function validateLocalTracks(
    trackIds: string[],
): Promise<SyncQueueItem[]> {
    const queue = await validateQueueTracks(
        trackIds.map((trackId) => ({ trackId })),
    );
    return queue.filter((item) => (item.originSource ?? "local") === "local");
}

function queueToJson(
    queue: SyncQueueItem[],
): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return queue.length === 0
        ? Prisma.DbNull
        : (queue as unknown as Prisma.InputJsonValue);
}

async function runPublicationLock<T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    options?: PublicationExecutionOptions,
): Promise<T> {
    let enteredMutationBoundary = false;
    try {
        return await withGroupMutationLock(groupId, operationName, operation, {
            signal: options?.signal,
            abandonOperationOnAbort: Boolean(options),
            beforeOperation: async () => {
                enteredMutationBoundary = true;
            },
            afterOperation: async () => {
                await flushGroupPublications(groupId);
                groupManager.markPublicationConfirmed(groupId);
            },
        });
    } catch (error) {
        if (options?.signal.aborted) throw options.signal.reason;
        if (error instanceof GroupError && error.code !== "CONFLICT") {
            throw error;
        }
        if (!enteredMutationBoundary && error instanceof GroupError) {
            throw error;
        }
        groupManager.invalidate(groupId);
        if (error instanceof GroupError) throw error;
        throw new GroupError(
            "CONFLICT",
            "Group state could not be synchronized. Please retry.",
        );
    }
}

interface InitialGroupPlayback {
    queue: SyncQueueItem[];
    currentIndex: number;
    currentTimeMs: number;
    isPlaying: boolean;
    trackId: string | null;
}

async function resolveInitialGroupPlayback(
    options: CreateGroupOptions,
): Promise<InitialGroupPlayback> {
    const allQueueInputs =
        Array.isArray(options.queueTracks) && options.queueTracks.length > 0
            ? options.queueTracks
            : (options.queueTrackIds ?? []).map((trackId) => ({ trackId }));
    const queue = await validateQueueTracks(
        allQueueInputs.slice(0, MAX_QUEUE_SIZE),
    );
    const requestedIndex = options.currentTrackId
        ? queue.findIndex(
              (track) =>
                  track.id === options.currentTrackId ||
                  track.localTrackId === options.currentTrackId,
          )
        : -1;
    const hasRequestedTrack = requestedIndex >= 0;
    const currentIndex = hasRequestedTrack ? requestedIndex : 0;
    const track = queue[currentIndex] ?? null;
    const requestedTimeMs = Number.isFinite(options.currentTimeMs)
        ? (options.currentTimeMs ?? 0)
        : 0;
    return {
        queue,
        currentIndex,
        currentTimeMs: Math.max(
            0,
            Math.min(requestedTimeMs, track ? track.duration * 1000 : 0),
        ),
        isPlaying: Boolean(
            options.isPlaying && queue.length > 0 && hasRequestedTrack,
        ),
        trackId: track?.localTrackId ?? null,
    };
}

async function persistCreatedGroup(
    userId: string,
    name: string,
    joinCode: string,
    visibility: "public" | "private",
    playback: InitialGroupPlayback,
    now: Date,
) {
    return prisma.$transaction(async (tx) => {
        await requireMembershipEligibleUser(tx, userId);
        const group = await tx.syncGroup.create({
            data: {
                name,
                joinCode,
                groupType: "host-follower",
                visibility,
                hostUserId: userId,
                queue: queueToJson(playback.queue),
                currentIndex: playback.currentIndex,
                trackId: playback.trackId,
                currentTime: playback.currentTimeMs / 1000,
                isPlaying: playback.isPlaying,
                stateVersion: 0,
                stateUpdatedAt: now,
            },
        });
        await tx.syncGroupMember.create({
            data: { syncGroupId: group.id, userId, isHost: true },
        });
        return group;
    });
}

type PersistedCreatedGroup = Awaited<ReturnType<typeof persistCreatedGroup>>;

async function publishCreatedGroup(
    dbGroup: PersistedCreatedGroup,
    userId: string,
    hostPresentationName: string,
    visibility: "public" | "private",
    playback: InitialGroupPlayback,
    now: Date,
): Promise<GroupSnapshot> {
    return runPublicationLock(dbGroup.id, "create-group", async (fence) => {
        await assertUserNotPendingDeletion(userId);
        const state = groupManager.create(dbGroup.id, {
            name: dbGroup.name,
            joinCode: dbGroup.joinCode,
            groupType: "host-follower",
            visibility,
            hostUserId: userId,
            hostUsername: hostPresentationName,
            queue: playback.queue,
            currentIndex: playback.currentIndex,
            currentTimeMs: playback.currentTimeMs,
            isPlaying: playback.isPlaying,
            createdAt: now,
        });
        const snapshot = groupManager.snapshot(state);
        const stored = await listenTogetherStateStore.setSnapshot(
            dbGroup.id,
            snapshot,
            fence.fencingToken,
        );
        if (stored === "stale") {
            throw new GroupError(
                "CONFLICT",
                "Created group state was superseded",
            );
        }
        return snapshot;
    });
}

// ---------------------------------------------------------------------------
// Public API — cold path
// ---------------------------------------------------------------------------

/**
 * Create a new Listen Together group.
 * Writes to DB and hydrates the in-memory manager.
 */
export async function createGroup(
    userId: string,
    username: string,
    options: CreateGroupOptions = {},
): Promise<GroupSnapshot> {
    return withListenTogetherMutationAdmission("create-group", () =>
        createAdmittedGroup(userId, username, options),
    );
}

async function createAdmittedGroup(
    userId: string,
    username: string,
    options: CreateGroupOptions,
): Promise<GroupSnapshot> {
    await maybeLeaveExistingAdmitted(userId);
    const hostPresentationName = await resolvePresentationName(
        userId,
        username,
    );
    const joinCode = await generateJoinCode();
    const playback = await resolveInitialGroupPlayback(options);
    const visibility = options.visibility ?? "public";
    const now = new Date();
    const name = options.name?.trim() || `${hostPresentationName}'s Group`;
    const dbGroup = await persistCreatedGroup(
        userId,
        name,
        joinCode,
        visibility,
        playback,
        now,
    );
    return publishCreatedGroup(
        dbGroup,
        userId,
        hostPresentationName,
        visibility,
        playback,
        now,
    );
}

async function prepareGroupJoin(
    userId: string,
    username: string,
    joinCodeInput: string,
): Promise<{ groupId: string; memberName: string; joinedAt: Date }> {
    const joinCode = normalizeJoinCode(joinCodeInput);
    if (joinCode.length !== JOIN_CODE_LENGTH) {
        throw new GroupError("INVALID", "Invalid join code");
    }
    const group = await prisma.syncGroup.findFirst({
        where: { joinCode, isActive: true },
        select: { id: true },
    });
    if (!group) throw new GroupError("NOT_FOUND", "Group not found");
    await maybeLeaveExistingAdmitted(userId, group.id);
    return {
        groupId: group.id,
        memberName: await resolvePresentationName(userId, username),
        joinedAt: new Date(),
    };
}

async function joinedResponseSnapshot(groupId: string): Promise<GroupSnapshot> {
    await ensureGroupInMemory(groupId);
    const snapshot = groupManager.snapshotById(groupId);
    if (!snapshot) {
        throw new Error(`Joined group ${groupId} has no response state`);
    }
    return snapshot;
}

/**
 * Join an existing group by join code.
 * Writes membership to DB and adds member to in-memory manager.
 */
export async function joinGroup(
    userId: string,
    username: string,
    joinCodeInput: string,
): Promise<GroupSnapshot> {
    return withListenTogetherMutationAdmission("join-group", () =>
        joinAdmittedGroup(userId, username, joinCodeInput),
    );
}

async function joinAdmittedGroup(
    userId: string,
    username: string,
    joinCodeInput: string,
): Promise<GroupSnapshot> {
    const prepared = await prepareGroupJoin(userId, username, joinCodeInput);
    return runPublicationLock(prepared.groupId, "join-group", async (fence) => {
        const captured = await captureGroupPublicationBase(prepared.groupId);
        const committed = await commitGroupJoin(
            prepared.groupId,
            userId,
            prepared.memberName,
            prepared.joinedAt,
            fence,
            captured?.hostUserId ??
                groupManager.get(prepared.groupId)?.hostUserId,
        );
        const member = {
            userId,
            username: prepared.memberName,
            isHost: userId === committed.hostUserId,
            joinedAt: prepared.joinedAt,
        };
        const snapshot = await publishCommittedJoin(
            prepared.groupId,
            captured,
            member,
            committed.hostUserId,
            committed.memberships,
            committed.membershipTransitioned,
            fence,
        );
        if (snapshot) {
            return snapshot;
        }
        return joinedResponseSnapshot(prepared.groupId);
    });
}

async function commitGroupJoin(
    groupId: string,
    userId: string,
    username: string,
    joinedAt: Date,
    fence: GroupMutationFence,
    capturedHostUserId?: string,
): Promise<CommittedJoin> {
    return prisma.$transaction((tx) =>
        withSyncGroupMembershipFence(tx, groupId, fence, async () => {
            await requireMembershipEligibleUser(tx, userId);
            const group = await tx.syncGroup.findUnique({
                where: { id: groupId },
                select: { isActive: true, hostUserId: true },
            });
            if (!group?.isActive) {
                throw new GroupError("NOT_FOUND", "Group not found");
            }
            const existingMembership = await tx.syncGroupMember.findUnique({
                where: { syncGroupId_userId: { syncGroupId: groupId, userId } },
                select: { leftAt: true },
            });
            const membershipTransitioned = existingMembership?.leftAt !== null;
            if (membershipTransitioned) {
                await tx.syncGroupMember.upsert({
                    where: {
                        syncGroupId_userId: { syncGroupId: groupId, userId },
                    },
                    update: { leftAt: null, joinedAt, isHost: false },
                    create: { syncGroupId: groupId, userId, isHost: false },
                });
            }
            const hostUserId = group.hostUserId ?? capturedHostUserId;
            if (!hostUserId) {
                throw new Error(`Active group ${groupId} has no host`);
            }
            const loadedMemberships = await loadPersistedMemberships(
                tx,
                groupId,
            );
            if (!loadedMemberships.some((member) => member.userId === userId)) {
                loadedMemberships.push({
                    userId,
                    username,
                    isHost: false,
                    joinedAt,
                });
            }
            const memberships = loadedMemberships.map((member) => ({
                ...member,
                isHost: member.userId === hostUserId,
            }));
            return { hostUserId, memberships, membershipTransitioned };
        }),
    );
}

/**
 * Join a group by its ID (used when a member reconnects).
 */
export async function joinGroupById(
    userId: string,
    username: string,
    groupId: string,
): Promise<GroupSnapshot> {
    return withListenTogetherMutationAdmission("join-group-by-id", () =>
        joinGroupByIdAdmitted(userId, username, groupId),
    );
}

/** Reconnect beneath an admission already owned by the socket command. */
export function joinGroupByIdAdmitted(
    userId: string,
    username: string,
    groupId: string,
): Promise<GroupSnapshot> {
    return runPublicationLock(groupId, "join-group-by-id", () =>
        joinGroupByIdLocked(userId, username, groupId),
    );
}

async function joinGroupByIdLocked(
    userId: string,
    username: string,
    groupId: string,
): Promise<GroupSnapshot> {
    await assertUserNotPendingDeletion(userId);
    const captured = await captureGroupPublicationBase(groupId);
    // Verify membership in DB
    const membership = await prisma.syncGroupMember.findFirst({
        where: { syncGroupId: groupId, userId, leftAt: null },
        select: {
            syncGroupId: true,
            joinedAt: true,
            syncGroup: { select: { hostUserId: true } },
        },
    });
    if (!membership)
        throw new GroupError("NOT_MEMBER", "Not a member of this group");
    const memberPresentationName = await resolvePresentationName(
        userId,
        username,
    );

    const authoritativeHostUserId = membership.syncGroup.hostUserId;
    const member = {
        userId,
        username: memberPresentationName,
        isHost: userId === authoritativeHostUserId,
        joinedAt:
            membership.joinedAt instanceof Date
                ? membership.joinedAt
                : new Date(),
    };
    if (captured) {
        return applyCommittedReconnect(
            captured,
            member,
            authoritativeHostUserId,
        );
    }

    // No playback base was publishable. Hydrate only for this caller's response.
    await ensureGroupInMemory(groupId);
    const responseSnapshot = groupManager.snapshotById(groupId);
    if (!responseSnapshot) {
        throw new GroupError("NOT_FOUND", "Group not found");
    }
    return responseSnapshot;
}

async function applyCommittedDeparture(
    userId: string,
    groupId: string,
    committed: CommittedDeparture,
    captured: GroupSnapshot | null,
    fence: GroupMutationFence,
    options?: PublicationExecutionOptions,
): Promise<LeaveResult> {
    options?.signal.throwIfAborted();
    if (committed.status !== "active") {
        const reason =
            committed.status === "ended" ? "All members left" : "Group ended";
        await publishCommittedEnd(groupId, captured, reason, fence, options);
        return { ended: true };
    }

    await publishCommittedDeparture(
        groupId,
        userId,
        captured,
        committed,
        fence,
        options,
    );
    return {
        ended: false,
        newHostUserId: committed.newHostUserId,
        newHostUsername: committed.newHostUsername,
    };
}

async function retainPendingDeletionDeparture(
    userId: string,
    groupId: string,
    trackCleanupPublication: boolean,
): Promise<void> {
    if (trackCleanupPublication) return;
    await prisma.syncGroupMember.updateMany({
        where: {
            syncGroupId: groupId,
            userId,
            user: { pendingDeletionAt: { not: null } },
        },
        data: { cleanupPublicationPending: true },
    });
}

/**
 * Leave a group. Handles host transfer and auto-disband.
 */
export async function leaveGroup(
    userId: string,
    groupId: string,
): Promise<LeaveResult> {
    return withListenTogetherMutationAdmission("leave-group", () =>
        leaveGroupAdmitted(userId, groupId),
    );
}

/** Leave beneath an admission already owned by a larger command. */
export function leaveGroupAdmitted(
    userId: string,
    groupId: string,
    trackCleanupPublication: boolean = false,
    options?: PublicationExecutionOptions,
): Promise<LeaveResult> {
    return runPublicationLock(
        groupId,
        "leave-group",
        async (fence) => {
            options?.signal.throwIfAborted();
            const captured = await captureGroupPublicationBase(groupId);
            options?.signal.throwIfAborted();
            const committed = await commitGroupDeparture(
                userId,
                groupId,
                fence,
                trackCleanupPublication,
                options?.signal,
            );
            options?.signal.throwIfAborted();
            try {
                return await applyCommittedDeparture(
                    userId,
                    groupId,
                    committed,
                    captured,
                    fence,
                    options,
                );
            } catch (error) {
                await retainPendingDeletionDeparture(
                    userId,
                    groupId,
                    trackCleanupPublication,
                );
                throw error;
            }
        },
        options,
    );
}

/**
 * End a group (host only). When the group is not hydrated in memory,
 * host authorization is enforced from the DB for multi-pod/post-restart cases.
 */
export async function endGroup(userId: string, groupId: string): Promise<void> {
    await withListenTogetherMutationAdmission("end-group", () =>
        endGroupAdmitted(userId, groupId),
    );
}

/** End beneath an admission; only cleanup may reconcile an inactive group. */
export async function endGroupAdmitted(
    userId: string,
    groupId: string,
    reconcileInactive: boolean = false,
    options?: PublicationExecutionOptions,
): Promise<void> {
    await runPublicationLock(
        groupId,
        "end-group",
        async (fence) => {
            options?.signal.throwIfAborted();
            const captured = await captureGroupPublicationBase(groupId);
            options?.signal.throwIfAborted();
            await endGroupInDb(
                groupId,
                userId,
                fence,
                reconcileInactive,
                options?.signal,
            );
            options?.signal.throwIfAborted();
            await publishCommittedEnd(
                groupId,
                captured,
                "Host ended the group",
                fence,
                options,
            );
        },
        options,
    );
}

/**
 * Get the count of all active groups (public + private).
 * Used by the sidebar to show a global "sessions active" indicator.
 */
export async function getActiveGroupCount(): Promise<number> {
    const result = await prisma.syncGroup.count({
        where: { isActive: true },
    });
    return result;
}

/**
 * Discover public groups.
 */
export async function discoverGroups(
    userId: string,
): Promise<DiscoverableGroup[]> {
    const groups = await prisma.syncGroup.findMany({
        where: { isActive: true, visibility: "public" },
        include: {
            hostUser: {
                select: { id: true, username: true, displayName: true },
            },
            track: {
                select: {
                    id: true,
                    title: true,
                    album: { select: { artist: { select: { name: true } } } },
                },
            },
            members: {
                where: { leftAt: null },
                select: { userId: true },
            },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
    });

    return groups.map((g) => {
        // Prefer in-memory state for live data
        const memGroup = groupManager.get(g.id);

        return {
            id: g.id,
            name: g.name,
            joinCode: g.joinCode,
            groupType: "host-follower",
            visibility: g.visibility as "public" | "private",
            host: {
                id: g.hostUser.id,
                username: g.hostUser.displayName?.trim() || g.hostUser.username,
            },
            memberCount: memGroup ? memGroup.members.size : g.members.length,
            isMember: memGroup
                ? memGroup.members.has(userId)
                : g.members.some((m) => m.userId === userId),
            isPlaying: memGroup ? memGroup.playback.isPlaying : g.isPlaying,
            currentTrack: (() => {
                if (memGroup) {
                    const track =
                        memGroup.playback.queue[memGroup.playback.currentIndex];
                    return track
                        ? {
                              id: track.id,
                              title: track.title,
                              artistName: track.artist.name,
                          }
                        : null;
                }
                return g.track
                    ? {
                          id: g.track.id,
                          title: g.track.title,
                          artistName: g.track.album.artist.name,
                      }
                    : null;
            })(),
        };
    });
}

/**
 * Get the user's current active group (if any).
 */
export async function getMyGroup(
    userId: string,
): Promise<GroupSnapshot | null> {
    const membership = await prisma.syncGroupMember.findFirst({
        where: { userId, leftAt: null, syncGroup: { isActive: true } },
        select: { syncGroupId: true },
    });

    if (!membership) return null;

    await ensureGroupInMemory(membership.syncGroupId);
    return groupManager.snapshotById(membership.syncGroupId) ?? null;
}

// ---------------------------------------------------------------------------
// Periodic persistence
// ---------------------------------------------------------------------------

let persistInterval: ReturnType<typeof setInterval> | null = null;

interface GroupPersistenceCapture {
    readonly group: GroupState;
    readonly id: string;
    readonly queue: SyncQueueItem[];
    readonly currentIndex: number;
    readonly isPlaying: boolean;
    readonly currentTimeSeconds: number;
    readonly stateVersion: number;
    readonly stateUpdatedAt: Date;
}

function captureGroupPersistence(
    group: GroupState,
    stopPlayback: boolean,
): GroupPersistenceCapture {
    const playback = group.playback;
    const currentPositionMs = playback.isPlaying
        ? playback.positionMs + (Date.now() - playback.lastPositionUpdate)
        : playback.positionMs;
    return {
        group,
        id: group.id,
        queue: structuredClone(playback.queue),
        currentIndex: playback.currentIndex,
        isPlaying: stopPlayback ? false : playback.isPlaying,
        currentTimeSeconds: currentPositionMs / 1000,
        stateVersion: playback.stateVersion,
        stateUpdatedAt: new Date(),
    };
}

async function persistGroupCapture(
    capture: GroupPersistenceCapture,
): Promise<boolean> {
    if (capture.group.persistenceValid === false) return false;
    const result = await prisma.syncGroup.updateMany({
        where: {
            id: capture.id,
            stateVersion: { lt: capture.stateVersion },
        },
        data: {
            trackId: capture.queue[capture.currentIndex]?.localTrackId ?? null,
            queue: queueToJson(capture.queue),
            currentIndex: capture.currentIndex,
            isPlaying: capture.isPlaying,
            currentTime: capture.currentTimeSeconds,
            stateVersion: capture.stateVersion,
            stateUpdatedAt: capture.stateUpdatedAt,
        },
    });
    if (result.count < 1) return false;
    groupManager.markClean(capture.id, capture.group, capture.stateVersion);
    return true;
}

/**
 * Executes startPersistLoop.
 */
export function startPersistLoop(): void {
    if (persistInterval) return;
    persistInterval = setInterval(persistDirtyGroups, PERSIST_INTERVAL_MS);
    logger.debug("[ListenTogether] Persistence loop started");
}

/**
 * Executes stopPersistLoop.
 */
export function stopPersistLoop(): void {
    if (persistInterval) {
        clearInterval(persistInterval);
        persistInterval = null;
    }
}

async function persistDirtyGroups(): Promise<void> {
    const captures = groupManager
        .dirtyGroups()
        .slice(0, MAX_PERSIST_GROUPS)
        .map((group) => captureGroupPersistence(group, false));
    for (const capture of captures) {
        try {
            await persistGroupCapture(capture);
        } catch (err) {
            logger.error(
                `[ListenTogether] Failed to persist group ${capture.id}:`,
                err,
            );
        }
    }
}

export interface PersistAllGroupsOptions {
    deadlineAtMs?: number;
}

interface ShutdownAbortScope {
    signal?: AbortSignal;
    dispose(): void;
}

function createShutdownAbortScope(deadlineAtMs?: number): ShutdownAbortScope {
    if (deadlineAtMs === undefined) return { dispose: () => undefined };
    const controller = new AbortController();
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        controller.abort(new Error("Shutdown persistence deadline expired"));
        return { signal: controller.signal, dispose: () => undefined };
    }
    const timer = setTimeout(
        () =>
            controller.abort(
                new Error("Shutdown persistence deadline expired"),
            ),
        remainingMs,
    );
    timer.unref?.();
    return {
        signal: controller.signal,
        dispose: () => clearTimeout(timer),
    };
}

async function persistShutdownGroupWithinDeadline(
    groupId: string,
    deadlineAtMs?: number,
): Promise<void> {
    const scope = createShutdownAbortScope(deadlineAtMs);
    try {
        scope.signal?.throwIfAborted();
        await persistShutdownGroup(groupId, scope.signal);
    } catch (error) {
        if (scope.signal?.aborted) {
            // Leave memory and PostgreSQL unchanged when a lock cannot be
            // acquired inside the original drain budget. An unfenced write is
            // less safe than skipping this group's final persistence.
            logger.warn(
                `[ListenTogether] Final persist deadline skipped ${groupId}:`,
                error,
            );
            return;
        }
        groupManager.invalidate(groupId);
        logger.error(
            `[ListenTogether] Final persist skipped for ${groupId}:`,
            error,
        );
    } finally {
        scope.dispose();
    }
}

/** Final persist for all groups on shutdown. */
export async function persistAllGroups(
    options: PersistAllGroupsOptions = {},
): Promise<void> {
    const groupIds = groupManager.allGroupIds().slice(0, MAX_PERSIST_GROUPS);
    for (const groupId of groupIds) {
        await persistShutdownGroupWithinDeadline(groupId, options.deadlineAtMs);
    }
}

async function persistShutdownGroup(
    groupId: string,
    signal?: AbortSignal,
): Promise<void> {
    await withListenTogetherShutdownMutationAdmission(() =>
        withGroupMutationLock(
            groupId,
            "shutdown-pause",
            async (fence) => {
                // Abort before allocating a higher version if Redis authority
                // cannot be read. A DB-only bump could outrank that snapshot.
                const stored =
                    await listenTogetherStateStore.getSnapshot(groupId);
                signal?.throwIfAborted();
                if (stored) groupManager.applyExternalSnapshot(stored);
                // A null read proves that Redis has no competing snapshot. A
                // versioned DB-only pause would therefore be safe, although the
                // normal publication path still writes Redis before PostgreSQL.
                const result = groupManager.pauseForShutdown(groupId);
                if (!result) return;
                if (result.paused) {
                    await enqueueGroupSnapshotPublication(
                        groupId,
                        result.snapshot,
                        undefined,
                        undefined,
                        [],
                        fence,
                    );
                    groupManager.markPublicationConfirmed(groupId);
                }
                await persistGroupCapture(
                    captureGroupPersistence(result.group, false),
                );
            },
            {
                signal,
                abandonOperationOnAbort: Boolean(signal),
            },
        ),
    );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function maybeLeaveExistingAdmitted(
    userId: string,
    targetGroupId?: string,
): Promise<void> {
    const existing = await prisma.syncGroupMember.findFirst({
        where: { userId, leftAt: null, syncGroup: { isActive: true } },
        select: { syncGroupId: true },
    });

    if (!existing) return;
    if (targetGroupId && existing.syncGroupId === targetGroupId) return;

    await leaveGroupAdmitted(userId, existing.syncGroupId);
}

/** Ensure a DB group is loaded into memory (for after server restart). */
async function ensureGroupInMemory(groupId: string): Promise<void> {
    if (groupManager.has(groupId)) return;

    const storedSnapshot = await listenTogetherStateStore.getSnapshot(groupId);
    if (storedSnapshot) {
        groupManager.applyExternalSnapshot(storedSnapshot);
        return;
    }

    const dbGroup = await prisma.syncGroup.findUnique({
        where: { id: groupId },
        include: {
            members: {
                where: { leftAt: null },
                include: {
                    user: {
                        select: { id: true, username: true, displayName: true },
                    },
                },
            },
        },
    });

    if (!dbGroup || !dbGroup.isActive) return;

    // Parse queue from JSONB
    const queue = parseQueueFromDb(dbGroup.queue);

    groupManager.hydrate(dbGroup.id, {
        name: dbGroup.name,
        joinCode: dbGroup.joinCode,
        groupType: "host-follower",
        visibility: dbGroup.visibility as "public" | "private",
        hostUserId: dbGroup.hostUserId,
        membershipVersion: Number(dbGroup.membershipFence),
        queue,
        currentIndex: dbGroup.currentIndex,
        isPlaying: dbGroup.isPlaying,
        currentTimeMs: dbGroup.currentTime * 1000, // DB stores seconds, manager uses ms
        stateVersion: dbGroup.stateVersion,
        createdAt: dbGroup.createdAt,
        members: dbGroup.members.map((m) => ({
            userId: m.userId,
            username: m.user.displayName?.trim() || m.user.username,
            isHost: m.isHost,
            joinedAt: m.joinedAt,
        })),
    });
}

function parseQueueFromDb(raw: Prisma.JsonValue | null): SyncQueueItem[] {
    if (!Array.isArray(raw)) return [];

    const result: SyncQueueItem[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const q = item as Record<string, unknown>;
        const artist = q.artist as Record<string, unknown> | undefined;
        const album = q.album as Record<string, unknown> | undefined;

        if (
            typeof q.id === "string" &&
            typeof q.title === "string" &&
            typeof q.duration === "number" &&
            artist &&
            typeof artist.name === "string" &&
            album &&
            typeof album.title === "string"
        ) {
            const provider = normalizeCanonicalMediaProviderIdentity({
                mediaSource: q.mediaSource,
                streamSource: q.streamSource,
                sourceType: q.sourceType,
                providerTrackId:
                    (q.provider as Record<string, unknown> | undefined)
                        ?.providerTrackId ?? q.providerTrackId,
                tidalTrackId:
                    (q.provider as Record<string, unknown> | undefined)
                        ?.tidalTrackId ?? q.tidalTrackId,
                youtubeVideoId:
                    (q.provider as Record<string, unknown> | undefined)
                        ?.youtubeVideoId ?? q.youtubeVideoId,
                youtubeAudioFormat:
                    (q.provider as Record<string, unknown> | undefined)
                        ?.youtubeAudioFormat ?? q.youtubeAudioFormat,
            });
            result.push({
                id: q.id,
                title: q.title,
                duration: q.duration,
                artist: {
                    id:
                        typeof artist.id === "string"
                            ? artist.id
                            : `artist:${q.id}`,
                    name: artist.name,
                },
                album: {
                    id:
                        typeof album.id === "string"
                            ? album.id
                            : `album:${q.id}`,
                    title: album.title,
                    coverArt:
                        typeof album.coverArt === "string"
                            ? album.coverArt
                            : null,
                },
                mediaSource: provider.source,
                provider,
                ...toLegacyStreamFields(provider),
                localTrackId:
                    typeof q.localTrackId === "string"
                        ? q.localTrackId
                        : undefined,
                trackTidalId:
                    typeof q.trackTidalId === "string"
                        ? q.trackTidalId
                        : undefined,
                trackYtMusicId:
                    typeof q.trackYtMusicId === "string"
                        ? q.trackYtMusicId
                        : undefined,
                trackMappingId:
                    typeof q.trackMappingId === "string"
                        ? q.trackMappingId
                        : undefined,
                originSource:
                    q.originSource === "tidal" ||
                    q.originSource === "youtube" ||
                    q.originSource === "peer" ||
                    q.originSource === "local"
                        ? q.originSource
                        : "local",
                peerOnline:
                    typeof q.peerOnline === "boolean"
                        ? q.peerOnline
                        : undefined,
            });
        }
    }
    return result;
}
