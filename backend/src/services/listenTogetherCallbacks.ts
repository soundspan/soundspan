import type {
    GroupSnapshot,
    PlaybackDelta,
    QueueDelta,
} from "./listenTogetherManager";
import { logger } from "../utils/logger";
import { config } from "../config";
import { listenTogetherClusterSync } from "./listenTogetherClusterSync";
import type { ClusterGroupMembership } from "./listenTogetherClusterSync";
import type { ClusterPublicationMetadata } from "./listenTogetherClusterSync";
import { randomUUID } from "crypto";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import {
    isListenTogetherDeadlineError,
    listenTogetherRetryDelayMs,
    waitForListenTogetherRetry,
    withListenTogetherDeadline,
    withListenTogetherDeadlineAt,
} from "./listenTogetherDeadline";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { GroupError } from "./listenTogetherGroupError";
import { releaseLocalGroupMutationState } from "./listenTogetherMutationLock";

const log = logger.child("ListenTogetherPublication");
const PUBLICATION_MAX_ATTEMPTS = 2;
const PUBLICATION_MAX_STAGES = 8;
const PUBLICATION_DEADLINE_MS = config.listenTogether.publicationDeadlineMs;
const pendingGroupPublications = new Map<string, Promise<void>>();

interface PublicationStage {
    name: string;
    publish: () => Promise<void | "halt">;
    effect: "none" | "guarded" | "deduplicated" | "external";
    lateCompletionHarmless?: boolean;
}

interface PublicationProgress {
    irreversible: boolean;
}

/** Optional caller lifetime for a queued publication. */
export interface PublicationExecutionOptions {
    signal: AbortSignal;
    deadlineAtMs: number;
}

/** Optional fence order attached to direct membership socket events. */
export interface MembershipFanoutMetadata {
    membershipVersion: number;
}

/** Socket-facing fanout used by ordered publication stages. */
export interface GroupPublicationBroadcaster {
    emitSnapshot(
        groupId: string,
        snapshot: GroupSnapshot,
    ): void | Promise<void>;
    emitEnded(groupId: string, reason: string): void | Promise<void>;
    emitMemberJoined(
        groupId: string,
        member: { userId: string; username: string },
        metadata?: MembershipFanoutMetadata,
    ): void | Promise<void>;
    emitMemberPresence(
        groupId: string,
        member: { userId: string; isConnected: boolean },
        metadata?: MembershipFanoutMetadata,
    ): void | Promise<void>;
    emitMemberLeft(
        groupId: string,
        member: {
            userId: string;
            username: string;
            newHostUserId?: string;
            newHostUsername?: string;
        },
        metadata?: MembershipFanoutMetadata,
    ): void | Promise<void>;
    revokeSockets(
        groupId: string,
        socketIds: string[],
        metadata?: MembershipFanoutMetadata,
        userId?: string,
    ): void | Promise<void>;
}

/** Membership-only detail that may accompany or replace a snapshot publication. */
export type GroupMembershipPublication =
    | {
          type: "joined";
          member: { userId: string; username: string };
      }
    | {
          type: "left";
          member: {
              userId: string;
              username: string;
              newHostUserId?: string;
              newHostUsername?: string;
          };
      };

let publicationBroadcaster: GroupPublicationBroadcaster | null = null;

/** Install the socket-facing broadcaster used by queued publications. */
export function configureGroupPublicationBroadcaster(
    broadcaster: GroupPublicationBroadcaster,
): void {
    publicationBroadcaster = broadcaster;
}

async function assertFenceBeforeEffect(
    fence: GroupMutationFence | undefined,
): Promise<void> {
    if (!fence) return;
    if (fence.isFenced()) {
        throw new GroupError(
            "CONFLICT",
            "Group coordination lease expired. Please retry.",
        );
    }
    await fence.assertCurrent?.();
}

async function awaitPublicationStage(
    stage: PublicationStage,
    progress: PublicationProgress,
    options?: PublicationExecutionOptions,
): Promise<void | "halt"> {
    options?.signal.throwIfAborted();
    if (stage.effect === "external" || stage.effect === "deduplicated") {
        progress.irreversible = true;
    }
    const operation = Promise.resolve().then(stage.publish);
    try {
        const operationName = `listen together ${stage.name}`;
        const result = options
            ? await withListenTogetherDeadlineAt(
                  operation,
                  operationName,
                  Math.min(
                      options.deadlineAtMs,
                      Date.now() + PUBLICATION_DEADLINE_MS,
                  ),
                  options.signal,
              )
            : await withListenTogetherDeadline(
                  operation,
                  operationName,
                  PUBLICATION_DEADLINE_MS,
              );
        if (stage.effect === "guarded" && result !== "halt") {
            progress.irreversible = true;
        }
        return result;
    } catch (error) {
        if (!isListenTogetherDeadlineError(error)) throw error;
        // The stage deadline is also the await deadline. Cleanup retries replay
        // idempotent effects; ordinary external stages are never retried by this
        // queue after an irreversible effect may have started.
        void operation.catch(() => undefined);
        if (stage.effect !== "none") progress.irreversible = true;
        throw error;
    }
}

async function runStageAttempt(
    stage: PublicationStage,
    fence: GroupMutationFence | undefined,
    progress: PublicationProgress,
    options?: PublicationExecutionOptions,
): Promise<void | "halt"> {
    options?.signal.throwIfAborted();
    if (stage.effect !== "none") {
        await assertFenceBeforeEffect(fence);
    }
    return awaitPublicationStage(stage, progress, options);
}

function publicationFailure(
    error: unknown,
    progress: PublicationProgress,
): unknown {
    if (!progress.irreversible) return error;
    return new GroupError(
        "CONFLICT",
        "Group state could not be synchronized. Please refresh.",
        false,
    );
}

async function handlePublicationAttemptFailure(
    error: unknown,
    context: {
        groupId: string;
        publicationName: string;
        stage: PublicationStage | undefined;
        attempt: number;
        fencingToken: number;
    },
    progress: PublicationProgress,
    options?: PublicationExecutionOptions,
): Promise<"retry"> {
    options?.signal.throwIfAborted();
    const stageName = context.stage?.name ?? "unknown";
    if (error instanceof GroupError && error.code === "CONFLICT") {
        log.debug("Fenced publication rejected", {
            ...context,
            stageName,
        });
        throw publicationFailure(error, progress);
    }
    const retryable =
        context.stage?.effect !== "external" &&
        context.attempt < PUBLICATION_MAX_ATTEMPTS;
    if (!retryable) {
        log.error("Publication failed after bounded retry", {
            ...context,
            stageName,
            error,
        });
        throw publicationFailure(error, progress);
    }
    log.warn("Publication failed; retrying through group queue", {
        ...context,
        stageName,
        error,
    });
    const retry = waitForListenTogetherRetry(
        listenTogetherRetryDelayMs(context.attempt, 20, 100),
    );
    if (options) {
        await withListenTogetherDeadlineAt(
            retry,
            "Listen Together publication retry",
            options.deadlineAtMs,
            options.signal,
        );
    } else {
        await retry;
    }
    return "retry";
}

async function runPublicationStages(
    groupId: string,
    publicationName: string,
    stages: PublicationStage[],
    fence?: GroupMutationFence,
    options?: PublicationExecutionOptions,
): Promise<void> {
    if (stages.length > PUBLICATION_MAX_STAGES) {
        throw new Error(`Publication stage limit exceeded for ${groupId}`);
    }
    const progress: PublicationProgress = {
        irreversible: false,
    };
    let stageIndex = 0;
    for (let attempt = 1; attempt <= PUBLICATION_MAX_ATTEMPTS; attempt += 1) {
        try {
            for (; stageIndex < stages.length; stageIndex += 1) {
                options?.signal.throwIfAborted();
                const outcome = await runStageAttempt(
                    stages[stageIndex],
                    fence,
                    progress,
                    options,
                );
                if (outcome === "halt") {
                    throw new GroupError(
                        "CONFLICT",
                        "Group state was superseded. Please retry.",
                    );
                }
            }
            return;
        } catch (error) {
            options?.signal.throwIfAborted();
            await handlePublicationAttemptFailure(
                error,
                {
                    groupId,
                    publicationName,
                    stage: stages[stageIndex],
                    attempt,
                    fencingToken: fence?.fencingToken ?? 0,
                },
                progress,
                options,
            );
        }
    }
}

function enqueueGroupPublication(
    groupId: string,
    publicationName: string,
    stages: PublicationStage[],
    fence?: GroupMutationFence,
    options?: PublicationExecutionOptions,
): Promise<void> {
    const previous = pendingGroupPublications.get(groupId) ?? Promise.resolve();
    let queued: Promise<void>;
    queued = previous
        .then(
            () => undefined,
            () => undefined,
        )
        .then(() =>
            runPublicationStages(
                groupId,
                publicationName,
                stages,
                fence,
                options,
            ),
        )
        .finally(() => {
            if (pendingGroupPublications.get(groupId) === queued) {
                pendingGroupPublications.delete(groupId);
            }
        });
    pendingGroupPublications.set(groupId, queued);
    return queued;
}

async function emitMembershipPublication(
    groupId: string,
    publication: GroupMembershipPublication,
    metadata: MembershipFanoutMetadata,
): Promise<void> {
    if (publication.type === "joined") {
        await publicationBroadcaster?.emitMemberJoined(
            groupId,
            publication.member,
            metadata,
        );
        return;
    }
    await publicationBroadcaster?.emitMemberLeft(
        groupId,
        publication.member,
        metadata,
    );
}

function clusterPublicationMetadata(
    fence?: GroupMutationFence,
): ClusterPublicationMetadata {
    return {
        fencingToken: fence?.fencingToken ?? 0,
        publicationId: randomUUID(),
    };
}

function membershipPublicationStages(
    groupId: string,
    publication: GroupMembershipPublication | undefined,
    membership: ClusterGroupMembership | undefined,
    revokedSocketIds: string[],
    clusterMetadata: ClusterPublicationMetadata,
): PublicationStage[] {
    const stages: PublicationStage[] = [];
    const fanoutMetadata = {
        membershipVersion: clusterMetadata.fencingToken,
    };
    if (publication) {
        stages.push({
            name: "membership-fanout",
            effect: "external",
            publish: () =>
                emitMembershipPublication(groupId, publication, fanoutMetadata),
        });
    }
    const departedUserId =
        publication?.type === "left" ? publication.member.userId : undefined;
    if (revokedSocketIds.length > 0 || departedUserId) {
        stages.push({
            name: "socket-revocation",
            effect: "external",
            publish: async () => {
                await publicationBroadcaster?.revokeSockets(
                    groupId,
                    revokedSocketIds,
                    fanoutMetadata,
                    departedUserId,
                );
            },
        });
    }
    if (membership) {
        stages.push({
            name: "cluster-membership-publication",
            effect: "deduplicated",
            lateCompletionHarmless: true,
            publish: () =>
                listenTogetherClusterSync.publishMembership(
                    groupId,
                    membership,
                    clusterMetadata,
                ),
        });
    }
    return stages;
}

function snapshotPersistenceStage(
    groupId: string,
    snapshot: GroupSnapshot,
    fence?: GroupMutationFence,
): PublicationStage {
    return {
        name: "snapshot-persistence",
        effect: "guarded",
        lateCompletionHarmless: true,
        publish: async () => {
            const result = await listenTogetherStateStore.setSnapshot(
                groupId,
                snapshot,
                fence?.fencingToken ?? 0,
            );
            return result === "stale" ? "halt" : undefined;
        },
    };
}

function orderedSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        membershipVersion: snapshot.membershipVersion ?? 0,
    };
}

function snapshotPublicationStages(
    groupId: string,
    snapshot: GroupSnapshot,
    membership?: GroupMembershipPublication,
    committedMembership?: ClusterGroupMembership,
    revokedSocketIds: string[] = [],
    fence?: GroupMutationFence,
    emitPayload?: () => void | Promise<void>,
): PublicationStage[] {
    const snapshotPayload = orderedSnapshot(snapshot);
    const membershipStages = membershipPublicationStages(
        groupId,
        membership,
        committedMembership,
        revokedSocketIds,
        clusterPublicationMetadata(fence),
    );
    const snapshotClusterMetadata = clusterPublicationMetadata(fence);
    return [
        snapshotPersistenceStage(groupId, snapshotPayload, fence),
        ...(emitPayload
            ? [
                  {
                      name: "payload-fanout",
                      effect: "external" as const,
                      publish: async () => {
                          await emitPayload();
                      },
                  },
              ]
            : []),
        ...membershipStages,
        {
            name: "cluster-snapshot-publication",
            effect: "deduplicated",
            lateCompletionHarmless: true,
            publish: () =>
                listenTogetherClusterSync.publishSnapshot(
                    groupId,
                    snapshotPayload,
                    snapshotClusterMetadata,
                ),
        },
        {
            name: "snapshot-fanout",
            effect: "external",
            publish: async () => {
                await publicationBroadcaster?.emitSnapshot(
                    groupId,
                    snapshotPayload,
                );
            },
        },
    ];
}

/** Queue one authoritative snapshot publication for a group. */
export function enqueueGroupSnapshotPublication(
    groupId: string,
    snapshot: GroupSnapshot,
    membership?: GroupMembershipPublication,
    committedMembership?: ClusterGroupMembership,
    revokedSocketIds: string[] = [],
    fence?: GroupMutationFence,
    emitPayload?: () => void | Promise<void>,
    options?: PublicationExecutionOptions,
): Promise<void> {
    const stages = snapshotPublicationStages(
        groupId,
        snapshot,
        membership,
        committedMembership,
        revokedSocketIds,
        fence,
        emitPayload,
    );
    return enqueueGroupPublication(groupId, "snapshot", stages, fence, options);
}

/** Queue socket fanout for a snapshot synchronized by another boundary. */
export function enqueueGroupSnapshotBroadcast(
    groupId: string,
    snapshot: GroupSnapshot,
): Promise<void> {
    return enqueueGroupPublication(groupId, "snapshot-broadcast", [
        {
            name: "snapshot-fanout",
            effect: "external",
            publish: async () => {
                await publicationBroadcaster?.emitSnapshot(groupId, snapshot);
            },
        },
    ]);
}

/** Queue an ended publication and authoritative snapshot deletion. */
export function enqueueGroupEndedPublication(
    groupId: string,
    reason: string,
    fence?: GroupMutationFence,
    options?: PublicationExecutionOptions,
): Promise<void> {
    const clusterMetadata = clusterPublicationMetadata(fence);
    return enqueueGroupPublication(
        groupId,
        "ended",
        [
            {
                name: "snapshot-deletion",
                effect: "guarded",
                lateCompletionHarmless: true,
                publish: async () => {
                    const result =
                        await listenTogetherStateStore.deleteSnapshot(
                            groupId,
                            fence?.fencingToken ?? 0,
                        );
                    return result === "stale" ? "halt" : undefined;
                },
            },
            {
                name: "cluster-ended-publication",
                effect: "deduplicated",
                lateCompletionHarmless: true,
                publish: () =>
                    listenTogetherClusterSync.publishEnded(
                        groupId,
                        clusterMetadata,
                    ),
            },
            {
                name: "ended-fanout",
                effect: "external",
                publish: async () => {
                    await publicationBroadcaster?.emitEnded(groupId, reason);
                },
            },
        ],
        fence,
        options,
    ).finally(() => releaseLocalGroupMutationState(groupId));
}

/** Queue socket fanout for an end synchronized by another boundary. */
export function enqueueGroupEndedBroadcast(
    groupId: string,
    reason: string,
): Promise<void> {
    return enqueueGroupPublication(groupId, "ended-broadcast", [
        {
            name: "ended-fanout",
            effect: "external",
            publish: async () => {
                await publicationBroadcaster?.emitEnded(groupId, reason);
            },
        },
    ]);
}

/** Queue membership-only fanout when no playback snapshot is authoritative. */
export function enqueueGroupMembershipPublication(
    groupId: string,
    membership: GroupMembershipPublication | undefined,
    committedMembership?: ClusterGroupMembership,
    revokedSocketIds: string[] = [],
    fence?: GroupMutationFence,
    options?: PublicationExecutionOptions,
): Promise<void> {
    const clusterMetadata = clusterPublicationMetadata(fence);
    const stages: PublicationStage[] = [
        {
            name: "fence-validation",
            effect: "guarded",
            lateCompletionHarmless: true,
            publish: async () => {
                const result = await listenTogetherStateStore.claimFence(
                    groupId,
                    fence?.fencingToken ?? 0,
                );
                return result === "stale" ? "halt" : undefined;
            },
        },
        ...membershipPublicationStages(
            groupId,
            membership,
            committedMembership,
            revokedSocketIds,
            clusterMetadata,
        ),
    ];
    return enqueueGroupPublication(
        groupId,
        "membership",
        stages,
        fence,
        options,
    );
}

/** Queue a presence-only socket event without publishing playback state. */
export function enqueueGroupPresenceBroadcast(
    groupId: string,
    member: { userId: string; isConnected: boolean },
    metadata: MembershipFanoutMetadata,
): Promise<void> {
    return enqueueGroupPublication(groupId, "presence", [
        {
            name: "presence-fanout",
            effect: "external",
            publish: async () => {
                await publicationBroadcaster?.emitMemberPresence(
                    groupId,
                    member,
                    metadata,
                );
            },
        },
    ]);
}

/** Queue availability fanout behind a current publication-fence claim. */
export function enqueueGroupAvailabilityPublication(
    groupId: string,
    fence: GroupMutationFence,
    emitAvailability: () => void | Promise<void>,
): Promise<void> {
    return enqueueGroupPublication(
        groupId,
        "availability",
        [
            {
                name: "fence-validation",
                effect: "guarded",
                lateCompletionHarmless: true,
                publish: async () => {
                    const result = await listenTogetherStateStore.claimFence(
                        groupId,
                        fence.fencingToken,
                    );
                    return result === "stale" ? "halt" : undefined;
                },
            },
            {
                name: "availability-fanout",
                effect: "external",
                publish: async () => emitAvailability(),
            },
        ],
        fence,
    );
}

/** Wait for all publications currently queued for one group. */
export async function flushGroupPublications(groupId: string): Promise<void> {
    const pending = pendingGroupPublications.get(groupId);
    if (pending) {
        await pending;
    }
}

/** Drop publication wiring during socket shutdown or test teardown. */
export function resetGroupPublications(): void {
    pendingGroupPublications.clear();
    publicationBroadcaster = null;
}

/** Controls whether a manager callback must also synchronize cluster state. */
export interface StatePublicationOptions {
    synchronize?: boolean;
}

/** Socket-facing callbacks emitted by the in-memory group manager. */
export interface ManagerCallbacks {
    onGroupState(
        groupId: string,
        snapshot: GroupSnapshot,
        options?: StatePublicationOptions,
        fence?: GroupMutationFence,
    ): void | Promise<void>;
    onPlaybackDelta(
        groupId: string,
        delta: PlaybackDelta,
        fence?: GroupMutationFence,
    ): void;
    onQueueDelta(
        groupId: string,
        delta: QueueDelta,
        fence?: GroupMutationFence,
    ): void;
    onWaiting(
        groupId: string,
        data: { trackId: string | null; currentIndex: number },
        fence?: GroupMutationFence,
    ): void;
    onPlayAt(
        groupId: string,
        data: { positionMs: number; serverTime: number; stateVersion: number },
        fence?: GroupMutationFence,
    ): void;
    onMemberJoined(
        groupId: string,
        member: { userId: string; username: string },
    ): void;
    onMemberPresence(
        groupId: string,
        member: { userId: string; isConnected: boolean },
    ): void;
    onMemberLeft(
        groupId: string,
        data: {
            userId: string;
            username: string;
            newHostUserId?: string;
            newHostUsername?: string;
        },
    ): void;
    onGroupEnded(
        groupId: string,
        reason: string,
        options?: StatePublicationOptions,
    ): void | Promise<void>;
    onBoundaryWatchdog?(
        groupId: string,
        data: { currentIndex: number; stateVersion: number },
    ): void;
    onReadyGateCompletion(
        groupId: string,
        data: { currentIndex: number; stateVersion: number },
    ): void;
}
