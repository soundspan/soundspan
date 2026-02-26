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
import { logger } from "../utils/logger";
import {
    groupManager,
    type SyncQueueItem,
    type GroupSnapshot,
    GroupError,
} from "./listenTogetherManager";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateGroupOptions {
    name?: string;
    visibility?: "public" | "private";
    queueTrackIds?: string[];
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
            candidate += JOIN_CODE_ALPHABET[crypto.randomInt(0, JOIN_CODE_ALPHABET.length)];
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
    fallbackUsername: string
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

/** Validate that track IDs exist and are local (have a filePath). */
async function validateLocalTracks(trackIds: string[]): Promise<SyncQueueItem[]> {
    if (!trackIds.length) return [];

    const unique = Array.from(new Set(trackIds));
    const tracks = await prisma.track.findMany({
        where: { id: { in: unique }, filePath: { not: "" } },
        select: {
            id: true,
            title: true,
            duration: true,
            filePath: true,
            album: {
                select: {
                    id: true,
                    title: true,
                    coverUrl: true,
                    artist: { select: { id: true, name: true } },
                },
            },
        },
    });

    const trackMap = new Map(tracks.map((t) => [t.id, t]));
    const queue: SyncQueueItem[] = [];

    for (const id of trackIds) {
        const t = trackMap.get(id);
        if (!t || !t.filePath) continue; // Skip non-local / invalid
        queue.push({
            id: t.id,
            title: t.title,
            duration: t.duration,
            artist: { id: t.album.artist.id, name: t.album.artist.name },
            album: { id: t.album.id, title: t.album.title, coverArt: t.album.coverUrl },
            mediaSource: "local",
            provider: { source: "local" },
        });
    }

    return queue;
}

function queueToJson(queue: SyncQueueItem[]): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return queue.length === 0 ? Prisma.DbNull : (queue as unknown as Prisma.InputJsonValue);
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
    // Auto-leave any existing group
    await maybeLeaveExisting(userId);

    const hostPresentationName = await resolvePresentationName(userId, username);
    const joinCode = await generateJoinCode();
    const initialQueue = await validateLocalTracks(options.queueTrackIds ?? []);
    const requestedTrackId = options.currentTrackId;
    const requestedTrackIndex = requestedTrackId
        ? initialQueue.findIndex((track) => track.id === requestedTrackId)
        : -1;
    const hasRequestedTrack = requestedTrackIndex >= 0;
    const initialCurrentIndex = hasRequestedTrack ? requestedTrackIndex : 0;
    const initialTrack = initialQueue[initialCurrentIndex] ?? null;
    const requestedTimeMs =
        typeof options.currentTimeMs === "number" && Number.isFinite(options.currentTimeMs)
            ? options.currentTimeMs
            : 0;
    const maxTrackMs = initialTrack ? initialTrack.duration * 1000 : 0;
    const initialCurrentTimeMs = Math.max(0, Math.min(requestedTimeMs, maxTrackMs));
    const initialIsPlaying = Boolean(
        options.isPlaying && initialQueue.length > 0 && hasRequestedTrack
    );
    const initialTrackId = initialTrack?.id ?? null;

    const now = new Date();

    const dbGroup = await prisma.$transaction(async (tx) => {
        const group = await tx.syncGroup.create({
            data: {
                name: options.name?.trim() || `${hostPresentationName}'s Group`,
                joinCode,
                groupType: "host-follower",
                visibility: options.visibility ?? "public",
                hostUserId: userId,
                queue: queueToJson(initialQueue),
                currentIndex: initialCurrentIndex,
                trackId: initialTrackId,
                currentTime: initialCurrentTimeMs / 1000,
                isPlaying: initialIsPlaying,
                stateVersion: 0,
                stateUpdatedAt: now,
            },
        });

        await tx.syncGroupMember.create({
            data: {
                syncGroupId: group.id,
                userId,
                isHost: true,
            },
        });

        return group;
    });

    // Hydrate in-memory
    const state = groupManager.create(dbGroup.id, {
        name: dbGroup.name,
        joinCode: dbGroup.joinCode,
        groupType: "host-follower",
        visibility: (options.visibility ?? "public") as "public" | "private",
        hostUserId: userId,
        hostUsername: hostPresentationName,
        queue: initialQueue,
        currentIndex: initialCurrentIndex,
        currentTimeMs: initialCurrentTimeMs,
        isPlaying: initialIsPlaying,
        createdAt: now,
    });

    const snapshot = groupManager.snapshot(state);
    await listenTogetherStateStore.setSnapshot(dbGroup.id, snapshot);
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
    const joinCode = normalizeJoinCode(joinCodeInput);
    if (joinCode.length !== JOIN_CODE_LENGTH) {
        throw new GroupError("INVALID", "Invalid join code");
    }

    // Find the group in DB
    const dbGroup = await prisma.syncGroup.findFirst({
        where: { joinCode, isActive: true },
        select: { id: true },
    });
    if (!dbGroup) throw new GroupError("NOT_FOUND", "Group not found");

    // Auto-leave previous group (if different)
    await maybeLeaveExisting(userId, dbGroup.id);
    const memberPresentationName = await resolvePresentationName(userId, username);

    const now = new Date();

    // Upsert membership in DB
    await prisma.syncGroupMember.upsert({
        where: { syncGroupId_userId: { syncGroupId: dbGroup.id, userId } },
        update: { leftAt: null, joinedAt: now, isHost: false },
        create: { syncGroupId: dbGroup.id, userId, isHost: false },
    });

    // Ensure group is in memory (may not be if server restarted)
    await ensureGroupInMemory(dbGroup.id);

    // Add to in-memory
    const snapshot = groupManager.addMember(
        dbGroup.id,
        userId,
        memberPresentationName
    );
    await listenTogetherStateStore.setSnapshot(dbGroup.id, snapshot);
    return snapshot;
}

/**
 * Join a group by its ID (used when a member reconnects).
 */
export async function joinGroupById(
    userId: string,
    username: string,
    groupId: string,
): Promise<GroupSnapshot> {
    // Verify membership in DB
    const membership = await prisma.syncGroupMember.findFirst({
        where: { syncGroupId: groupId, userId, leftAt: null },
    });
    if (!membership) throw new GroupError("NOT_MEMBER", "Not a member of this group");
    const memberPresentationName = await resolvePresentationName(userId, username);

    // Ensure in memory
    await ensureGroupInMemory(groupId);

    const group = groupManager.get(groupId);
    if (!group) throw new GroupError("NOT_FOUND", "Group not found");

    // Make sure the member exists in-memory
    if (!group.members.has(userId)) {
        groupManager.addMember(groupId, userId, memberPresentationName);
    }

    const snapshot = groupManager.snapshot(group);
    await listenTogetherStateStore.setSnapshot(groupId, snapshot);
    return snapshot;
}

/**
 * Leave a group. Handles host transfer and auto-disband.
 */
export async function leaveGroup(userId: string, groupId: string): Promise<LeaveResult> {
    // Remove from in-memory first
    const result = groupManager.has(groupId)
        ? groupManager.removeMember(groupId, userId)
        : { ended: false };

    // Update DB
    const now = new Date();
    await prisma.syncGroupMember.updateMany({
        where: { syncGroupId: groupId, userId, leftAt: null },
        data: { leftAt: now, isHost: false },
    });

    if (result.ended) {
        await endGroupInDb(groupId);
        groupManager.remove(groupId);
        await listenTogetherStateStore.deleteSnapshot(groupId);
    } else if (result.newHostUserId) {
        // Update host in DB
        await prisma.$transaction([
            prisma.syncGroup.update({
                where: { id: groupId },
                data: { hostUserId: result.newHostUserId },
            }),
            prisma.syncGroupMember.updateMany({
                where: { syncGroupId: groupId, leftAt: null },
                data: { isHost: false },
            }),
            prisma.syncGroupMember.updateMany({
                where: { syncGroupId: groupId, userId: result.newHostUserId, leftAt: null },
                data: { isHost: true },
            }),
        ]);
    }

    const snapshot = groupManager.snapshotById(groupId);
    if (snapshot) {
        await listenTogetherStateStore.setSnapshot(groupId, snapshot);
    }

    return result;
}

/**
 * End a group (host only).
 */
export async function endGroup(userId: string, groupId: string): Promise<void> {
    // Will throw if not host
    if (groupManager.has(groupId)) {
        groupManager.endGroup(groupId, userId);
    }

    await endGroupInDb(groupId);
    groupManager.remove(groupId);
    await listenTogetherStateStore.deleteSnapshot(groupId);
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
export async function discoverGroups(userId: string): Promise<DiscoverableGroup[]> {
    const groups = await prisma.syncGroup.findMany({
        where: { isActive: true, visibility: "public" },
        include: {
            hostUser: { select: { id: true, username: true, displayName: true } },
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
                    const track = memGroup.playback.queue[memGroup.playback.currentIndex];
                    return track
                        ? { id: track.id, title: track.title, artistName: track.artist.name }
                        : null;
                }
                return g.track
                    ? { id: g.track.id, title: g.track.title, artistName: g.track.album.artist.name }
                    : null;
            })(),
        };
    });
}

/**
 * Get the user's current active group (if any).
 */
export async function getMyGroup(userId: string): Promise<GroupSnapshot | null> {
    const membership = await prisma.syncGroupMember.findFirst({
        where: { userId, leftAt: null, syncGroup: { isActive: true } },
        select: { syncGroupId: true },
    });

    if (!membership) return null;

    await ensureGroupInMemory(membership.syncGroupId);
    return groupManager.snapshotById(membership.syncGroupId) ?? null;
}

/**
 * Validate track IDs and return queue items.
 * Exported for use by the socket layer when adding tracks to queue.
 */
export { validateLocalTracks };

// ---------------------------------------------------------------------------
// Periodic persistence
// ---------------------------------------------------------------------------

let persistInterval: ReturnType<typeof setInterval> | null = null;

export function startPersistLoop(): void {
    if (persistInterval) return;
    persistInterval = setInterval(persistDirtyGroups, PERSIST_INTERVAL_MS);
    logger.debug("[ListenTogether] Persistence loop started");
}

export function stopPersistLoop(): void {
    if (persistInterval) {
        clearInterval(persistInterval);
        persistInterval = null;
    }
}

async function persistDirtyGroups(): Promise<void> {
    const dirty = groupManager.dirtyGroups();
    if (dirty.length === 0) return;

    for (const group of dirty) {
        try {
            const pb = group.playback;
            const currentPos = pb.isPlaying
                ? pb.positionMs + (Date.now() - pb.lastPositionUpdate)
                : pb.positionMs;

            await prisma.syncGroup.update({
                where: { id: group.id },
                data: {
                    trackId: pb.queue[pb.currentIndex]?.id ?? null,
                    queue: queueToJson(pb.queue),
                    currentIndex: pb.currentIndex,
                    isPlaying: pb.isPlaying,
                    currentTime: currentPos / 1000, // DB stores seconds
                    stateVersion: pb.stateVersion,
                    stateUpdatedAt: new Date(),
                    hostUserId: group.hostUserId,
                },
            });

            groupManager.markClean(group.id);
        } catch (err) {
            logger.error(`[ListenTogether] Failed to persist group ${group.id}:`, err);
        }
    }
}

/** Final persist for all groups on shutdown. */
export async function persistAllGroups(): Promise<void> {
    const ids = groupManager.allGroupIds();
    for (const id of ids) {
        const group = groupManager.get(id);
        if (!group) continue;
        try {
            const pb = group.playback;
            const currentPos = pb.isPlaying
                ? pb.positionMs + (Date.now() - pb.lastPositionUpdate)
                : pb.positionMs;

            await prisma.syncGroup.update({
                where: { id: group.id },
                data: {
                    trackId: pb.queue[pb.currentIndex]?.id ?? null,
                    queue: queueToJson(pb.queue),
                    currentIndex: pb.currentIndex,
                    isPlaying: false, // Stop on shutdown
                    currentTime: currentPos / 1000,
                    stateVersion: pb.stateVersion,
                    stateUpdatedAt: new Date(),
                    hostUserId: group.hostUserId,
                },
            });
        } catch (err) {
            logger.error(`[ListenTogether] Final persist failed for ${id}:`, err);
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function maybeLeaveExisting(userId: string, targetGroupId?: string): Promise<void> {
    const existing = await prisma.syncGroupMember.findFirst({
        where: { userId, leftAt: null, syncGroup: { isActive: true } },
        select: { syncGroupId: true },
    });

    if (!existing) return;
    if (targetGroupId && existing.syncGroupId === targetGroupId) return;

    await leaveGroup(userId, existing.syncGroupId);
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
                    user: { select: { id: true, username: true, displayName: true } },
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
            artist && typeof artist.id === "string" && typeof artist.name === "string" &&
            album && typeof album.id === "string" && typeof album.title === "string"
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
            });
            result.push({
                id: q.id,
                title: q.title,
                duration: q.duration,
                artist: { id: artist.id, name: artist.name },
                album: {
                    id: album.id,
                    title: album.title,
                    coverArt: typeof album.coverArt === "string" ? album.coverArt : null,
                },
                mediaSource: provider.source,
                provider,
                ...toLegacyStreamFields(provider),
            });
        }
    }
    return result;
}

async function endGroupInDb(groupId: string): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
        prisma.syncGroup.update({
            where: { id: groupId },
            data: {
                isActive: false,
                endedAt: now,
                isPlaying: false,
                stateUpdatedAt: now,
            },
        }),
        prisma.syncGroupMember.updateMany({
            where: { syncGroupId: groupId, leftAt: null },
            data: { leftAt: now, isHost: false },
        }),
    ]);
}
