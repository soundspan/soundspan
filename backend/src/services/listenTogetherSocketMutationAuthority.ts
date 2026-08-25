import type { Namespace } from "socket.io";
import { config } from "../config";
import { logger } from "../utils/logger";
import { enqueueGroupEndedBroadcast } from "./listenTogetherCallbacks";
import { GroupError, groupManager } from "./listenTogetherManager";
import type { GroupSnapshot } from "./listenTogetherTypes";
import { releaseLocalGroupMutationState } from "./listenTogetherMutationLock";
import { endAllGroupSockets } from "./listenTogetherSocketRevocation";
import { listenTogetherStateStore } from "./listenTogetherStateStore";

const log = logger.child("ListenTogetherSocketMutationAuthority");
const REDIS_FENCING_ENABLED =
    config.listenTogether.mutationLockEnabled ||
    config.listenTogether.stateStoreEnabled ||
    config.listenTogether.stateSyncEnabled;

type BeforeSocketRevocation = (groupId: string, userId: string) => void;

async function endClusterGroup(
    namespace: Namespace,
    groupId: string,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    await endAllGroupSockets(namespace, groupId, "Group ended", beforeRevoke);
    groupManager.remove(groupId);
    releaseLocalGroupMutationState(groupId);
}

async function emitMissingAuthorityEnd(groupId: string): Promise<void> {
    try {
        await enqueueGroupEndedBroadcast(groupId, "Group ended");
    } catch (error) {
        log.warn("Missing-authority ended fanout failed", { groupId, error });
    }
}

async function endMissingAuthoritySockets(
    namespace: Namespace | null,
    groupId: string,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    if (!namespace) return;
    await endAllGroupSockets(namespace, groupId, "Group ended", beforeRevoke);
}

/** Hydrate one locked socket mutation or reject a locally stale ended group. */
export async function hydrateSocketMutationAuthority(
    groupId: string,
    namespace: Namespace | null,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    const authoritativeSnapshot =
        await listenTogetherStateStore.getSnapshot(groupId);
    if (authoritativeSnapshot) {
        groupManager.applyExternalSnapshot(authoritativeSnapshot);
        return;
    }
    if (!REDIS_FENCING_ENABLED || !listenTogetherStateStore.isEnabled()) {
        return;
    }
    groupManager.invalidate(groupId);
    releaseLocalGroupMutationState(groupId);
    await endMissingAuthoritySockets(namespace, groupId, beforeRevoke);
    await emitMissingAuthorityEnd(groupId);
    throw new GroupError("NOT_FOUND", "Group not found");
}

/** Bind cluster authority recovery and ended events to local socket cleanup. */
export function createClusterSocketAuthorityHandlers(
    namespace: Namespace,
    beforeRevoke: BeforeSocketRevocation,
) {
    return {
        endedHandler: (groupId: string) => () =>
            endClusterGroup(namespace, groupId, beforeRevoke),
        recoveryHandler: async (
            groupId: string,
            snapshot: GroupSnapshot | null,
        ): Promise<void> => {
            groupManager.invalidate(groupId);
            if (snapshot) {
                groupManager.applyExternalSnapshot(snapshot);
                return;
            }
            await endClusterGroup(namespace, groupId, beforeRevoke);
        },
    };
}
