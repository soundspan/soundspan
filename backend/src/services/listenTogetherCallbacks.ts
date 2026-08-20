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
const pendingGroupPublications = new Map<string, Promise<void>>();

/** Socket-facing fanout invoked only after authoritative publication succeeds. */
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
    publish: () => Promise<void>,
): Promise<void> {
    for (let attempt = 1; attempt <= PUBLICATION_MAX_ATTEMPTS; attempt += 1) {
        try {
            await publish();
            return;
        } catch (error) {
            if (attempt < PUBLICATION_MAX_ATTEMPTS) {
                log.warn("Publication failed; retrying through group queue", {
                    groupId,
                    publicationName,
                    attempt,
                    error,
                });
                continue;
            }
            log.error("Publication failed after bounded retry", {
                groupId,
                publicationName,
                attempt,
                error,
            });
        }
    }
}

function enqueueGroupPublication(
    groupId: string,
    publicationName: string,
    publish: () => Promise<void>,
): Promise<void> {
    const previous = pendingGroupPublications.get(groupId) ?? Promise.resolve();
    let queued: Promise<void>;
    queued = previous
        .then(
            () => undefined,
            () => undefined,
        )
        .then(() => runPublicationWithRetry(groupId, publicationName, publish))
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

async function publishMembershipChange(
    groupId: string,
    publication: GroupMembershipPublication | undefined,
    membership: ClusterGroupMembership | undefined,
    revokedSocketIds: string[],
): Promise<void> {
    if (publication) {
        await emitMembershipPublication(groupId, publication);
    }
    if (membership) {
        await listenTogetherClusterSync.publishMembership(groupId, membership);
    }
    if (revokedSocketIds.length > 0) {
        await publicationBroadcaster?.revokeSockets(groupId, revokedSocketIds);
    }
}

/** Queue one authoritative snapshot publication for a group. */
export function enqueueGroupSnapshotPublication(
    groupId: string,
    snapshot: GroupSnapshot,
    membership?: GroupMembershipPublication,
    committedMembership?: ClusterGroupMembership,
    revokedSocketIds: string[] = [],
): Promise<void> {
    return enqueueGroupPublication(groupId, "snapshot", async () => {
        await listenTogetherStateStore.setSnapshot(groupId, snapshot);
        await publishMembershipChange(
            groupId,
            membership,
            committedMembership,
            revokedSocketIds,
        );
        await listenTogetherClusterSync.publishSnapshot(groupId, snapshot);
        await publicationBroadcaster?.emitSnapshot(groupId, snapshot);
    });
}

/** Queue socket fanout for a snapshot synchronized by another boundary. */
export function enqueueGroupSnapshotBroadcast(
    groupId: string,
    snapshot: GroupSnapshot,
): Promise<void> {
    return enqueueGroupPublication(groupId, "snapshot-broadcast", async () => {
        await publicationBroadcaster?.emitSnapshot(groupId, snapshot);
    });
}

/** Queue an ended publication and authoritative snapshot deletion. */
export function enqueueGroupEndedPublication(
    groupId: string,
    reason: string,
): Promise<void> {
    return enqueueGroupPublication(groupId, "ended", async () => {
        await listenTogetherStateStore.deleteSnapshot(groupId);
        await listenTogetherClusterSync.publishEnded(groupId);
        await publicationBroadcaster?.emitEnded(groupId, reason);
    });
}

/** Queue socket fanout for an end synchronized by another boundary. */
export function enqueueGroupEndedBroadcast(
    groupId: string,
    reason: string,
): Promise<void> {
    return enqueueGroupPublication(groupId, "ended-broadcast", async () => {
        await publicationBroadcaster?.emitEnded(groupId, reason);
    });
}

/** Queue membership-only fanout when no playback snapshot is authoritative. */
export function enqueueGroupMembershipPublication(
    groupId: string,
    membership: GroupMembershipPublication | undefined,
    committedMembership?: ClusterGroupMembership,
    revokedSocketIds: string[] = [],
): Promise<void> {
    return enqueueGroupPublication(groupId, "membership", () =>
        publishMembershipChange(
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
    return enqueueGroupPublication(groupId, "presence", async () => {
        await publicationBroadcaster?.emitMemberPresence(groupId, member);
    });
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
