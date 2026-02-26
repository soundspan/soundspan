"use client";

import { listenTogetherSocket } from "./listen-together-socket";
import {
    createLatestAsyncOperationState,
    enqueueLatestAsyncOperation,
} from "./latest-async-operation";

export const LISTEN_TOGETHER_SESSION_STORAGE_KEY = "soundspan_listen_together_session";
export const LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY =
    "soundspan_listen_together_membership_pending";

export interface ListenTogetherSessionSnapshot {
    groupId: string;
    isHost: boolean;
    playback: {
        isPlaying: boolean;
        positionMs: number;
        serverTime: number;
        currentIndex: number;
    };
}

export interface ListenTogetherOptimisticTrackSelectionPolicy {
    resetPersistedTrackStartPosition: boolean;
    guardRemoteApply: boolean;
}

export type ListenTogetherHostTrackOperation =
    | { action: "next" }
    | { action: "previous" }
    | { action: "set-track"; index: number };

interface QueuedHostTrackOperation {
    operation: ListenTogetherHostTrackOperation;
    conflictRetryCount: number;
    generation: number;
}

interface ListenTogetherAckLikeError extends Error {
    code?: string;
    transient?: boolean;
    retryable?: boolean;
    retryAfterMs?: number;
}

const HOST_TRACK_OPERATION_CONFLICT_RECOVERY_MAX_RETRIES = 12;
const LISTEN_TOGETHER_OPTIMISTIC_TRACK_SELECTION_POLICY: ListenTogetherOptimisticTrackSelectionPolicy =
    Object.freeze({
        resetPersistedTrackStartPosition: false,
        guardRemoteApply: true,
    });

const listenTogetherHostTrackOperationState =
    createLatestAsyncOperationState<QueuedHostTrackOperation>();
let latestHostTrackOperationGeneration = 0;
let inMemorySessionSnapshot: ListenTogetherSessionSnapshot | null = null;
let inMemoryMembershipPending = false;

const isWindowUnavailable = (): boolean => typeof window === "undefined";

export function getListenTogetherOptimisticTrackSelectionPolicy(): ListenTogetherOptimisticTrackSelectionPolicy {
    return LISTEN_TOGETHER_OPTIMISTIC_TRACK_SELECTION_POLICY;
}

function runListenTogetherHostTrackOperation(
    queuedOperation: QueuedHostTrackOperation,
): Promise<void> {
    if (queuedOperation.generation !== latestHostTrackOperationGeneration) {
        return Promise.resolve();
    }

    const operation = queuedOperation.operation;
    if (operation.action === "next") {
        return listenTogetherSocket.next();
    }
    if (operation.action === "previous") {
        return listenTogetherSocket.previous();
    }
    return listenTogetherSocket.setTrack(operation.index);
}

function parseSessionSnapshot(
    raw: string | null,
): ListenTogetherSessionSnapshot | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as ListenTogetherSessionSnapshot;
        if (
            !parsed ||
            typeof parsed.groupId !== "string" ||
            typeof parsed.isHost !== "boolean" ||
            !parsed.playback ||
            typeof parsed.playback.isPlaying !== "boolean" ||
            typeof parsed.playback.positionMs !== "number" ||
            typeof parsed.playback.serverTime !== "number" ||
            typeof parsed.playback.currentIndex !== "number"
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function getListenTogetherSessionSnapshot(): ListenTogetherSessionSnapshot | null {
    if (isWindowUnavailable()) return inMemorySessionSnapshot;
    try {
        const raw = window.localStorage.getItem(LISTEN_TOGETHER_SESSION_STORAGE_KEY);
        const parsed = parseSessionSnapshot(raw);
        if (parsed || raw === null) {
            inMemorySessionSnapshot = parsed;
            return parsed;
        }

        inMemorySessionSnapshot = null;
        return null;
    } catch {
        return inMemorySessionSnapshot;
    }
}

export function setListenTogetherSessionSnapshot(snapshot: ListenTogetherSessionSnapshot | null): void {
    inMemorySessionSnapshot = snapshot;
    if (isWindowUnavailable()) return;
    try {
        if (!snapshot) {
            window.localStorage.removeItem(LISTEN_TOGETHER_SESSION_STORAGE_KEY);
            return;
        }
        window.localStorage.setItem(
            LISTEN_TOGETHER_SESSION_STORAGE_KEY,
            JSON.stringify(snapshot),
        );
    } catch {
        // Ignore storage failures
    }
}

export function isListenTogetherMembershipPending(): boolean {
    if (isWindowUnavailable()) return inMemoryMembershipPending;
    try {
        const pending =
            window.localStorage.getItem(
                LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY,
            ) === "1";
        inMemoryMembershipPending = pending;
        return pending;
    } catch {
        return inMemoryMembershipPending;
    }
}

export function setListenTogetherMembershipPending(pending: boolean): void {
    inMemoryMembershipPending = pending;
    if (isWindowUnavailable()) return;
    try {
        if (pending) {
            window.localStorage.setItem(
                LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY,
                "1",
            );
            return;
        }
        window.localStorage.removeItem(
            LISTEN_TOGETHER_MEMBERSHIP_PENDING_STORAGE_KEY,
        );
    } catch {
        // Ignore storage failures
    }
}

export function isListenTogetherActiveOrPending(): boolean {
    const snapshot = getListenTogetherSessionSnapshot();
    if (snapshot?.groupId) {
        return true;
    }
    return isListenTogetherMembershipPending();
}

export async function requestListenTogetherGroupResync(
    groupId?: string | null,
): Promise<void> {
    const targetGroupId = groupId ?? listenTogetherSocket.activeGroupId;
    if (!targetGroupId) {
        return;
    }

    await listenTogetherSocket.joinGroup(targetGroupId);
}

function isRetryableConflictError(
    error: unknown,
): error is ListenTogetherAckLikeError {
    return (
        error instanceof Error &&
        (error as ListenTogetherAckLikeError).code === "CONFLICT" &&
        ((error as ListenTogetherAckLikeError).retryable === true ||
            (error as ListenTogetherAckLikeError).transient === true)
    );
}

function resolveConflictRetryDelayMs(error: ListenTogetherAckLikeError): number {
    if (
        typeof error.retryAfterMs === "number" &&
        Number.isFinite(error.retryAfterMs) &&
        error.retryAfterMs > 0
    ) {
        return Math.min(1500, Math.max(50, Math.floor(error.retryAfterMs)));
    }
    return 120;
}

function enqueueHostTrackOperation(operation: QueuedHostTrackOperation): void {
    enqueueLatestAsyncOperation(
        listenTogetherHostTrackOperationState,
        operation,
        runListenTogetherHostTrackOperation,
        {
            onError: async (error, failedOperation) => {
                if (
                    isRetryableConflictError(error) &&
                    failedOperation.generation === latestHostTrackOperationGeneration &&
                    failedOperation.conflictRetryCount <
                        HOST_TRACK_OPERATION_CONFLICT_RECOVERY_MAX_RETRIES
                ) {
                    const retryOperation: QueuedHostTrackOperation = {
                        operation: failedOperation.operation,
                        generation: failedOperation.generation,
                        conflictRetryCount: failedOperation.conflictRetryCount + 1,
                    };
                    const retryDelayMs = resolveConflictRetryDelayMs(error);
                    setTimeout(() => {
                        if (
                            retryOperation.generation !==
                                latestHostTrackOperationGeneration ||
                            listenTogetherHostTrackOperationState.hasQueuedArg ||
                            !listenTogetherSocket.hasActiveGroup
                        ) {
                            return;
                        }
                        enqueueHostTrackOperation(retryOperation);
                    }, retryDelayMs);
                    return;
                }

                try {
                    await requestListenTogetherGroupResync();
                } catch {
                    // Ignore recovery failures; active session callbacks surface state.
                }
            },
        },
    );
}

export function enqueueLatestListenTogetherHostTrackOperation(
    operation: ListenTogetherHostTrackOperation,
): void {
    latestHostTrackOperationGeneration += 1;
    enqueueHostTrackOperation({
        operation,
        conflictRetryCount: 0,
        generation: latestHostTrackOperationGeneration,
    });
}
