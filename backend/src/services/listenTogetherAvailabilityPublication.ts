import type { Namespace } from "socket.io";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
    resolveQueueForUser,
    type ResolvedSource,
} from "./listenTogetherResolution";
import { groupManager, type GroupSnapshot } from "./listenTogetherManager";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import {
    captureAvailabilityIdentity,
    matchesAvailabilityIdentity,
} from "./listenTogetherAvailability";
import { enqueueGroupAvailabilityPublication } from "./listenTogetherCallbacks";
import { withListenTogetherDeadline } from "./listenTogetherDeadline";

const log = logger.child("ListenTogetherAvailability");
const MAX_AVAILABILITY_SOCKETS = 10_000;
const AVAILABILITY_RESOLUTION_CONCURRENCY = 8;

interface AvailabilitySocket {
    data?: { userId?: unknown };
    emit(event: string, payload: unknown): void;
}

interface AvailabilityPayloadItem {
    queueIndex: number;
    available: boolean;
    source?: "local" | "tidal" | "youtube";
    localTrackId?: string;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    reason?: string;
}

interface ResolvedUserAvailability {
    sockets: AvailabilitySocket[];
    userId: string;
    unavailableIndices: number[];
    availability: AvailabilityPayloadItem[];
}

interface AvailabilityRequest {
    ns: Namespace;
    groupId: string;
    withLock: AvailabilityMutationLock;
    snapshot: GroupSnapshot;
    token: number;
    cancelled: boolean;
    deadlineAtMs: number;
    controller: AbortController;
    resolve(result: boolean): void;
}

interface AvailabilityPassState {
    active: boolean;
    currentToken: number;
    activeRequest: AvailabilityRequest | null;
    queued: AvailabilityRequest | null;
}

/** Lock boundary used to revalidate and publish one availability result set. */
export type AvailabilityMutationLock = <T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    options?: {
        signal?: AbortSignal;
        abandonOperationOnAbort?: boolean;
        flushPublications?: boolean;
    },
) => Promise<T>;

const availabilityPasses = new Map<string, AvailabilityPassState>();
let availabilityShuttingDown = false;

function availabilityItem(
    queueIndex: number,
    resolved: ResolvedSource,
): AvailabilityPayloadItem {
    return {
        queueIndex,
        available: resolved.available,
        source: resolved.available ? resolved.source : undefined,
        localTrackId:
            resolved.available && resolved.source === "local"
                ? resolved.trackId
                : undefined,
        tidalTrackId:
            resolved.available && resolved.source === "tidal"
                ? resolved.tidalTrackId
                : undefined,
        youtubeVideoId:
            resolved.available && resolved.source === "youtube"
                ? resolved.youtubeVideoId
                : undefined,
        reason: resolved.available ? undefined : resolved.reason,
    };
}

function groupSocketsByUser(
    sockets: AvailabilitySocket[],
): Array<[string, AvailabilitySocket[]]> {
    const byUser = new Map<string, AvailabilitySocket[]>();
    for (const socket of sockets.slice(0, MAX_AVAILABILITY_SOCKETS)) {
        const userId =
            typeof socket.data?.userId === "string" ? socket.data.userId : null;
        if (!userId) continue;
        const userSockets = byUser.get(userId) ?? [];
        userSockets.push(socket);
        byUser.set(userId, userSockets);
    }
    return Array.from(byUser.entries());
}

async function resolveForUser(
    userId: string,
    sockets: AvailabilitySocket[],
    snapshot: GroupSnapshot,
    signal: AbortSignal,
): Promise<ResolvedUserAvailability | null> {
    try {
        signal.throwIfAborted();
        const resolved = await resolveQueueForUser(
            snapshot.playback.queue,
            userId,
            { signal },
        );
        signal.throwIfAborted();
        const unavailableIndices: number[] = [];
        const availability = [...resolved.entries()].map(([index, source]) => {
            if (!source.available) unavailableIndices.push(index);
            return availabilityItem(index, source);
        });
        return { sockets, userId, unavailableIndices, availability };
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        log.warn("Failed to resolve per-user availability", {
            groupId: snapshot.id,
            userId,
            error,
        });
        return null;
    }
}

async function resolveUserWorker(
    users: Array<[string, AvailabilitySocket[]]>,
    snapshot: GroupSnapshot,
    workerIndex: number,
    output: ResolvedUserAvailability[],
    signal: AbortSignal,
): Promise<void> {
    for (
        let index = workerIndex;
        index < MAX_AVAILABILITY_SOCKETS;
        index += AVAILABILITY_RESOLUTION_CONCURRENCY
    ) {
        const user = users[index];
        if (!user) return;
        signal.throwIfAborted();
        const result = await resolveForUser(user[0], user[1], snapshot, signal);
        if (result) output.push(result);
    }
}

async function resolveForUsers(
    ns: Namespace,
    groupId: string,
    snapshot: GroupSnapshot,
    signal: AbortSignal,
): Promise<ResolvedUserAvailability[]> {
    signal.throwIfAborted();
    const sockets = (await ns
        .in(groupId)
        .fetchSockets()) as unknown as AvailabilitySocket[];
    signal.throwIfAborted();
    const users = groupSocketsByUser(sockets);
    const output: ResolvedUserAvailability[] = [];
    const workers = Array.from(
        { length: Math.min(AVAILABILITY_RESOLUTION_CONCURRENCY, users.length) },
        (_value, index) =>
            resolveUserWorker(users, snapshot, index, output, signal),
    );
    await Promise.all(workers);
    return output;
}

function requestIsCurrent(request: AvailabilityRequest): boolean {
    const state = availabilityPasses.get(request.groupId);
    return (
        !availabilityShuttingDown &&
        !request.cancelled &&
        !request.controller.signal.aborted &&
        Date.now() < request.deadlineAtMs &&
        state?.currentToken === request.token
    );
}

async function applyAvailability(
    request: AvailabilityRequest,
    resolved: ResolvedUserAvailability[],
): Promise<boolean> {
    const identity = captureAvailabilityIdentity(request.snapshot);
    return request.withLock(
        request.groupId,
        "availability-publication",
        async (fence) => {
            const current = groupManager.snapshotById(request.groupId);
            if (
                !requestIsCurrent(request) ||
                !current ||
                !matchesAvailabilityIdentity(current, identity)
            ) {
                return false;
            }
            for (const result of resolved) {
                groupManager.setUnavailableIndices(
                    request.groupId,
                    result.userId,
                    result.unavailableIndices,
                );
            }
            await enqueueGroupAvailabilityPublication(
                request.groupId,
                fence,
                () => {
                    if (!requestIsCurrent(request)) return;
                    const latest = groupManager.snapshotById(request.groupId);
                    if (
                        !latest ||
                        !matchesAvailabilityIdentity(latest, identity)
                    ) {
                        return;
                    }
                    for (const result of resolved) {
                        for (const socket of result.sockets) {
                            socket.emit("group:availability", {
                                availability: result.availability,
                                stateVersion: identity.stateVersion,
                            });
                        }
                    }
                },
            );
            return true;
        },
        {
            signal: request.controller.signal,
            abandonOperationOnAbort: true,
            flushPublications: false,
        },
    );
}

async function executeAvailabilityPass(
    request: AvailabilityRequest,
): Promise<boolean> {
    const resolved = await resolveForUsers(
        request.ns,
        request.groupId,
        request.snapshot,
        request.controller.signal,
    );
    if (!requestIsCurrent(request)) return false;
    return applyAvailability(request, resolved);
}

function finishAvailabilityPass(
    request: AvailabilityRequest,
    state: AvailabilityPassState,
): void {
    const queued = state.queued;
    state.queued = null;
    if (state.activeRequest === request) state.activeRequest = null;
    if (!queued || availabilityShuttingDown) {
        state.active = false;
        if (availabilityPasses.get(request.groupId) === state) {
            availabilityPasses.delete(request.groupId);
        }
        queued?.resolve(false);
        return;
    }
    void runAvailabilityPass(queued, state);
}

async function runAvailabilityPass(
    request: AvailabilityRequest,
    state: AvailabilityPassState,
): Promise<void> {
    state.active = true;
    state.activeRequest = request;
    request.deadlineAtMs =
        Date.now() + config.listenTogether.publicationDeadlineMs;
    const operation = executeAvailabilityPass(request);
    try {
        const result = await withListenTogetherDeadline(
            operation,
            "listen together availability pass",
            Math.max(1, request.deadlineAtMs - Date.now()),
        );
        request.resolve(result);
    } catch (error) {
        request.cancelled = true;
        request.controller.abort(error);
        log.warn("Availability pass exceeded its overall boundary", {
            groupId: request.groupId,
            error,
        });
        request.resolve(false);
        // A stale operation cannot emit after cancellation because the queued
        // callback rechecks its generation and deadline. Bound settlement so a
        // blackholed dependency cannot prevent the latest request from running.
        try {
            await withListenTogetherDeadline(
                operation.catch(() => false),
                "listen together abandoned availability settlement",
                config.listenTogether.publicationDeadlineMs,
            );
        } catch {
            void operation.catch(() => undefined);
        }
    } finally {
        finishAvailabilityPass(request, state);
    }
}

/** Coalesce per-group availability work and publish only the latest snapshot. */
export function publishAvailabilityForGroup(
    ns: Namespace,
    groupId: string,
    withLock: AvailabilityMutationLock,
    snapshot?: GroupSnapshot,
): Promise<boolean> {
    const capturedSnapshot = snapshot ?? groupManager.snapshotById(groupId);
    if (!capturedSnapshot || availabilityShuttingDown)
        return Promise.resolve(false);
    const state = availabilityPasses.get(groupId) ?? {
        active: false,
        currentToken: 0,
        activeRequest: null,
        queued: null,
    };
    state.currentToken += 1;
    state.activeRequest?.controller.abort(
        new Error("Availability request superseded"),
    );
    availabilityPasses.set(groupId, state);
    return new Promise<boolean>((resolve) => {
        const request = {
            ns,
            groupId,
            withLock,
            snapshot: capturedSnapshot,
            token: state.currentToken,
            cancelled: false,
            deadlineAtMs: Number.MAX_SAFE_INTEGER,
            controller: new AbortController(),
            resolve,
        };
        if (!state.active) {
            void runAvailabilityPass(request, state);
            return;
        }
        state.queued?.resolve(false);
        state.queued = request;
    });
}

/** Cancel queued availability work and suppress late side effects. */
export function shutdownAvailabilityPublications(): void {
    availabilityShuttingDown = true;
    for (const state of availabilityPasses.values()) {
        state.currentToken += 1;
        state.activeRequest?.controller.abort(
            new Error("Availability publication shutdown"),
        );
        state.queued?.controller.abort(
            new Error("Availability publication shutdown"),
        );
        state.queued?.resolve(false);
        state.queued = null;
    }
}

/** Re-enable availability work for a fresh socket lifecycle. */
export function resetAvailabilityPublications(): void {
    availabilityShuttingDown = false;
}
