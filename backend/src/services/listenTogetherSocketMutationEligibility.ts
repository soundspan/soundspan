import type { Namespace } from "socket.io";
import { GroupError, groupManager } from "./listenTogetherManager";
import { revokeUserSockets } from "./listenTogetherSocketRevocation";
import { assertUserNotPendingDeletion } from "./listenTogetherUserEligibility";

type BeforeSocketRevocation = (groupId: string, userId: string) => void;

/** Reject and locally revoke a lock-owning socket actor marked for deletion. */
export async function assertSocketMutationUserEligible(
    namespace: Namespace | null,
    groupId: string,
    userId: string | undefined,
    beforeRevoke: BeforeSocketRevocation,
): Promise<void> {
    if (!userId) return;
    try {
        await assertUserNotPendingDeletion(userId);
    } catch (error) {
        if (
            error instanceof GroupError &&
            (error.code === "NOT_ALLOWED" || error.code === "NOT_FOUND")
        ) {
            if (namespace) {
                await revokeUserSockets(
                    namespace,
                    userId,
                    [groupId],
                    undefined,
                    beforeRevoke,
                );
            }
            groupManager.evictLocalMember(groupId, userId);
        }
        throw error;
    }
}
