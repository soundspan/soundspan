import type { ListenTogetherSessionSnapshot } from "@/lib/listen-together-session";

const FOLLOWER_DRIFT_SEEK_THRESHOLD_SEC = 1.5;

/** True when a member event originated in a different group than the session's. */
export function isStaleGroupEvent(
    event: { groupId?: string },
    sessionGroupId: string,
): boolean {
    return event.groupId !== undefined && event.groupId !== sessionGroupId;
}

export interface ResolveListenTogetherHostControlInput {
    activeGroupId: string | null | undefined;
    hostUserId: string | null | undefined;
    userId: string | null | undefined;
    snapshot: ListenTogetherSessionSnapshot | null;
}

/**
 * Decide whether the current user holds host playback authority for a group.
 */
export function canIssueListenTogetherHostPlaybackCommand(
    input: ResolveListenTogetherHostControlInput,
): boolean {
    if (!input.activeGroupId) return false;

    const hasUserId =
        typeof input.userId === "string" && input.userId.length > 0;
    const hasHostUserId =
        typeof input.hostUserId === "string" && input.hostUserId.length > 0;

    if (hasUserId && hasHostUserId) {
        return input.hostUserId === input.userId;
    }

    if (!input.snapshot || !input.snapshot.isHost) {
        return false;
    }

    return input.snapshot.groupId === input.activeGroupId;
}
const MAX_TRANSPORT_COMPENSATION_MS = 5_000;

export interface FollowerSeekInput {
    positionMs: number;
    serverTimeMs: number | undefined;
    isPlaying: boolean;
    trackDurationSec: number | null | undefined;
    currentTimeSec: number;
    nowMs: number;
    clockOffsetMs: number;
}

interface ReconnectSeekInput extends FollowerSeekInput {
    isHost: boolean;
}

/**
 * Resolve where a follower's player should sit on the group timeline.
 * Returns the target seconds plus whether local playback has drifted far
 * enough that a corrective seek is warranted.
 */
export function resolveFollowerSeekTarget(input: FollowerSeekInput): {
    targetSec: number;
    drifted: boolean;
} {
    let targetMs = Math.max(0, input.positionMs);
    if (input.isPlaying && input.serverTimeMs) {
        targetMs = computeCompensatedTargetMs(
            input.positionMs,
            input.serverTimeMs,
            input.nowMs,
            input.clockOffsetMs,
            MAX_TRANSPORT_COMPENSATION_MS,
        );
    }
    if (input.trackDurationSec) {
        targetMs = Math.min(targetMs, input.trackDurationSec * 1000);
    }
    const targetSec = targetMs / 1000;
    const drifted =
        Math.abs(input.currentTimeSec - targetSec) >
        FOLLOWER_DRIFT_SEEK_THRESHOLD_SEC;
    return { targetSec, drifted };
}

/** Resolve the post-reload position without replacing a host's local timeline. */
export function resolveReconnectSeekTarget(input: ReconnectSeekInput): number {
    if (input.isHost) {
        return Number.isFinite(input.currentTimeSec)
            ? Math.max(0, input.currentTimeSec)
            : 0;
    }
    return resolveFollowerSeekTarget(input).targetSec;
}

/**
 * Compute a server-timeline playback target with bounded transport latency.
 */
export function computeCompensatedTargetMs(
    positionMs: number,
    serverTimeMs: number,
    nowMs: number,
    clientClockOffsetMs: number,
    maxCompensationMs: number,
): number {
    const ageMs = nowMs - clientClockOffsetMs - serverTimeMs;
    const compensationMs = Math.min(
        Math.max(ageMs, 0),
        Math.max(maxCompensationMs, 0),
    );
    return Math.max(positionMs, 0) + compensationMs;
}
