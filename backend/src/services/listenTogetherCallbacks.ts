import type {
    GroupSnapshot,
    PlaybackDelta,
    QueueDelta,
} from "./listenTogetherManager";
import { logger } from "../utils/logger";
import { listenTogetherClusterSync } from "./listenTogetherClusterSync";
import type { ClusterGroupMembership } from "./listenTogetherClusterSync";
import { listenTogetherStateStore } from "./listenTogetherStateStore";

const log = logger.child("ListenTogetherPublication");
const PUBLICATION_MAX_ATTEMPTS = 2;
const PUBLICATION_MAX_STAGES = 6;
const pendingGroupPublications = new Map<string, Promise<void>>();

interface PublicationStage {
    name: string;
    publish: () => Promise<void>;
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
    ): void | Promise<void>;
    emitMemberPresence(
        groupId: string,
        member: { userId: string; isConnected: boolean },
    ): void | Promise<void>;
    emitMemberLeft(
        groupId: string,
        member: {
            userId: string;
            username: string;
            newHostUserId?: string;
            newHostUsername?: string;
        },
    ): void | Promise<void>;
    revokeSockets(groupId: string, socketIds: string[]): void | Promise<void>;
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

async function runPublicationWithRetry(
    groupId: string,
    publicationName: string,
    stages: PublicationStage[],
): Promise<void> {
    if (stages.length > PUBLICATION_MAX_STAGES) {
        throw new Error(`Publication stage limit exceeded for ${groupId}`);
    }
    const completedStages = new Set<number>();
    for (let attempt = 1; attempt <= PUBLICATION_MAX_ATTEMPTS; attempt += 1) {
        try {
            for (
                let stageIndex = 0;
                stageIndex < stages.length &&
                stageIndex < PUBLICATION_MAX_STAGES;
                stageIndex += 1
            ) {
                if (completedStages.has(stageIndex)) continue;
                await stages[stageIndex].publish();
                completedStages.add(stageIndex);
            }
            return;
        } catch (error) {
            const failedStageIndex = completedStages.size;
            const stageName = stages[failedStageIndex]?.name ?? "unknown";
            if (attempt < PUBLICATION_MAX_ATTEMPTS) {
                log.warn("Publication failed; retrying through group queue", {
                    groupId,
                    publicationName,
                    stageName,
                    attempt,
                    error,
                });
                continue;
            }
            log.error("Publication failed after bounded retry", {
                groupId,
                publicationName,
                stageName,
                attempt,
                error,
            });
        }
    }
}

function enqueueGroupPublication(
    groupId: string,
    publicationName: string,
    stages: PublicationStage[],
): Promise<void> {
    const previous = pendingGroupPublications.get(groupId) ?? Promise.resolve();
    let queued: Promise<void>;
    queued = previous
        .then(
            () => undefined,
            () => undefined,
        )
        .then(() => runPublicationWithRetry(groupId, publicationName, stages))
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
): Promise<void> {
    if (publication.type === "joined") {
        await publicationBroadcaster?.emitMemberJoined(
            groupId,
            publication.member,
        );
        return;
    }
    await publicationBroadcaster?.emitMemberLeft(groupId, publication.member);
}

function membershipPublicationStages(
    groupId: string,
    publication: GroupMembershipPublication | undefined,
    membership: ClusterGroupMembership | undefined,
    revokedSocketIds: string[],
): PublicationStage[] {
    const stages: PublicationStage[] = [];
    if (publication) {
        stages.push({
            name: "membership-fanout",
            publish: () => emitMembershipPublication(groupId, publication),
        });
    }
    if (revokedSocketIds.length > 0) {
        stages.push({
            name: "socket-revocation",
            publish: async () => {
                await publicationBroadcaster?.revokeSockets(
                    groupId,
                    revokedSocketIds,
                );
            },
        });
    }
    if (membership) {
        stages.push({
            name: "cluster-membership-publication",
            publish: () =>
                listenTogetherClusterSync.publishMembership(
                    groupId,
                    membership,
                ),
        });
    }
    return stages;
}

/** Queue one authoritative snapshot publication for a group. */
export function enqueueGroupSnapshotPublication(
    groupId: string,
    snapshot: GroupSnapshot,
    membership?: GroupMembershipPublication,
    committedMembership?: ClusterGroupMembership,
    revokedSocketIds: string[] = [],
): Promise<void> {
    const stages = membershipPublicationStages(
        groupId,
        membership,
        committedMembership,
        revokedSocketIds,
    );
    stages.push(
        {
            name: "snapshot-persistence",
            publish: () =>
                listenTogetherStateStore.setSnapshot(groupId, snapshot),
        },
        {
            name: "cluster-snapshot-publication",
            publish: () =>
                listenTogetherClusterSync.publishSnapshot(groupId, snapshot),
        },
        {
            name: "snapshot-fanout",
            publish: async () => {
                await publicationBroadcaster?.emitSnapshot(groupId, snapshot);
            },
        },
    );
    return enqueueGroupPublication(groupId, "snapshot", stages);
}

/** Queue socket fanout for a snapshot synchronized by another boundary. */
export function enqueueGroupSnapshotBroadcast(
    groupId: string,
    snapshot: GroupSnapshot,
): Promise<void> {
    return enqueueGroupPublication(groupId, "snapshot-broadcast", [
        {
            name: "snapshot-fanout",
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
): Promise<void> {
    return enqueueGroupPublication(groupId, "ended", [
        {
            name: "snapshot-deletion",
            publish: () => listenTogetherStateStore.deleteSnapshot(groupId),
        },
        {
            name: "cluster-ended-publication",
            publish: () => listenTogetherClusterSync.publishEnded(groupId),
        },
        {
            name: "ended-fanout",
            publish: async () => {
                await publicationBroadcaster?.emitEnded(groupId, reason);
            },
        },
    ]);
}

/** Queue socket fanout for an end synchronized by another boundary. */
export function enqueueGroupEndedBroadcast(
    groupId: string,
    reason: string,
): Promise<void> {
    return enqueueGroupPublication(groupId, "ended-broadcast", [
        {
            name: "ended-fanout",
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
): Promise<void> {
    return enqueueGroupPublication(
        groupId,
        "membership",
        membershipPublicationStages(
            groupId,
            membership,
            committedMembership,
            revokedSocketIds,
        ),
    );
}

/** Queue a presence-only socket event without publishing playback state. */
export function enqueueGroupPresenceBroadcast(
    groupId: string,
    member: { userId: string; isConnected: boolean },
): Promise<void> {
    return enqueueGroupPublication(groupId, "presence", [
        {
            name: "presence-fanout",
            publish: async () => {
                await publicationBroadcaster?.emitMemberPresence(
                    groupId,
                    member,
                );
            },
        },
    ]);
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
    ): void | Promise<void>;
    onPlaybackDelta(groupId: string, delta: PlaybackDelta): void;
    onQueueDelta(groupId: string, delta: QueueDelta): void;
    onWaiting(
        groupId: string,
        data: { trackId: string | null; currentIndex: number },
    ): void;
    onPlayAt(
        groupId: string,
        data: { positionMs: number; serverTime: number; stateVersion: number },
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
}
