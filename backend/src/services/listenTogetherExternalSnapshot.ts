import type {
    GroupPlayback,
    GroupSnapshot,
    GroupState,
    SyncQueueItem,
} from "./listenTogetherManager";
import {
    advanceSnapshotWatermark,
    compensateSnapshotPosition,
    mergeSnapshotMembers,
    reconcileHostFlags,
    shouldApplyIncomingPlayback,
} from "./listenTogetherSnapshot";

interface ExternalPlaybackCapture {
    queue: SyncQueueItem[];
    currentIndex: number;
    positionMs: number;
    serverTime: number;
    stateVersion: number;
    isPlaying: boolean;
    readyDeadlineMs: number | null;
    applyPlayback: boolean;
}

function clampIndex(index: number, length: number): number {
    if (length <= 0) return 0;
    return Math.min(Math.max(index, 0), length - 1);
}

function snapshotMembershipVersion(snapshot: GroupSnapshot): number | null {
    const version = snapshot.membershipVersion;
    return Number.isSafeInteger(version) && (version ?? -1) >= 0
        ? (version ?? null)
        : null;
}

function captureExternalPlayback(
    snapshot: GroupSnapshot,
    existing: GroupState | undefined,
    now: number,
    maxQueueSize: number,
): ExternalPlaybackCapture {
    const rawQueue = Array.isArray(snapshot.playback?.queue)
        ? snapshot.playback.queue
        : [];
    const queue = rawQueue.slice(0, maxQueueSize);
    const stateVersion = Math.max(0, snapshot.playback?.stateVersion ?? 0);
    const serverTime = Math.max(0, snapshot.playback?.serverTime ?? now);
    const rawDeadline = snapshot.readyDeadlineMs;
    return {
        queue,
        currentIndex: clampIndex(
            snapshot.playback?.currentIndex ?? 0,
            queue.length,
        ),
        positionMs: Math.max(0, snapshot.playback?.positionMs ?? 0),
        serverTime,
        stateVersion,
        isPlaying: Boolean(snapshot.playback?.isPlaying),
        readyDeadlineMs:
            typeof rawDeadline === "number" && Number.isFinite(rawDeadline)
                ? Math.max(0, rawDeadline)
                : null,
        applyPlayback: shouldApplyIncomingPlayback(
            existing,
            stateVersion,
            serverTime,
        ),
    };
}

function externalReadyUserIds(
    snapshot: GroupSnapshot,
    existing: GroupState | undefined,
    incomingVersion: number,
): Set<string> {
    const ready = new Set(
        Array.isArray(snapshot.readyUserIds)
            ? snapshot.readyUserIds.filter(
                  (userId): userId is string => typeof userId === "string",
              )
            : [],
    );
    if (existing && incomingVersion <= existing.playback.stateVersion) {
        for (const userId of existing.readyUserIds) ready.add(userId);
    }
    return ready;
}

function externalPlaybackState(
    capture: ExternalPlaybackCapture,
    existing: GroupState | undefined,
    now: number,
): GroupPlayback {
    const current = existing?.playback;
    const watermark = advanceSnapshotWatermark(
        current?.lastAppliedSnapshotServerTime ?? 0,
        capture.serverTime,
    );
    if (!capture.applyPlayback && current) {
        return { ...current, lastAppliedSnapshotServerTime: watermark };
    }
    return {
        queue: capture.queue,
        currentIndex: capture.currentIndex,
        isPlaying: capture.isPlaying,
        positionMs: compensateSnapshotPosition(
            capture.positionMs,
            capture.serverTime,
            now,
            capture.isPlaying,
        ),
        lastPositionUpdate: now,
        lastAppliedSnapshotServerTime: watermark,
        stateVersion: capture.stateVersion,
    };
}

/** Build one bounded external snapshot adoption without producing callbacks. */
export function buildExternalGroup(
    snapshot: GroupSnapshot,
    existing: GroupState | undefined,
    now: number,
    maxQueueSize: number,
    readyGateTimeoutMs: number,
): GroupState {
    const capture = captureExternalPlayback(
        snapshot,
        existing,
        now,
        maxQueueSize,
    );
    const readyUserIds = externalReadyUserIds(
        snapshot,
        existing,
        capture.stateVersion,
    );
    const incomingMembershipVersion = snapshotMembershipVersion(snapshot);
    const applyMembership =
        !existing ||
        incomingMembershipVersion === null ||
        incomingMembershipVersion >= existing.membershipVersion;
    const members = applyMembership
        ? mergeSnapshotMembers(
              snapshot.members ?? [],
              existing?.members,
              readyUserIds,
              now,
          )
        : existing.members;
    const hostUserId = applyMembership
        ? snapshot.hostUserId
        : existing.hostUserId;
    reconcileHostFlags(members, hostUserId);
    const syncState =
        capture.applyPlayback || !existing
            ? snapshot.syncState
            : existing.syncState;
    const existingDeadline = existing?.readyDeadlineMs ?? null;
    const readyDeadlineMs =
        syncState === "waiting"
            ? capture.applyPlayback || !existing
                ? (capture.readyDeadlineMs ?? now + readyGateTimeoutMs)
                : (existingDeadline ?? now + readyGateTimeoutMs)
            : null;
    return {
        id: snapshot.id,
        name: snapshot.name,
        joinCode: snapshot.joinCode,
        groupType: snapshot.groupType,
        visibility: snapshot.visibility,
        hostUserId,
        membershipVersion: Math.max(
            existing?.membershipVersion ?? 0,
            incomingMembershipVersion ?? 0,
        ),
        syncState,
        playback: externalPlaybackState(capture, existing, now),
        members,
        readyUserIds,
        readyTimeout: null,
        readyDeadlineMs,
        boundaryTimeout: null,
        lastActivity: now,
        createdAt: existing?.createdAt ?? new Date(),
        dirty: false,
        playbackAuthoritative: true,
        persistenceValid: true,
        normalizedFromPlaying: false,
        lastPublishedStateVersion: capture.stateVersion,
    };
}
