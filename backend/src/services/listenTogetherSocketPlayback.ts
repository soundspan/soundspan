import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import { GroupError, groupManager } from "./listenTogetherManager";

/** Playback command accepted from one authenticated Listen Together socket. */
export interface SocketPlaybackRequest {
    action: string;
    positionMs?: number;
    index?: number;
    stateVersion?: number;
}

function applySeek(
    groupId: string,
    userId: string,
    data: SocketPlaybackRequest,
    fence: GroupMutationFence,
): void {
    if (typeof data.positionMs !== "number") {
        throw new GroupError("INVALID", "positionMs required for seek");
    }
    if (
        data.stateVersion !== undefined &&
        (!Number.isInteger(data.stateVersion) || data.stateVersion < 0)
    ) {
        throw new GroupError(
            "INVALID",
            "stateVersion must be a non-negative integer",
        );
    }
    groupManager.seek(
        groupId,
        userId,
        data.positionMs,
        data.stateVersion,
        fence,
    );
}

/** Apply one validated socket playback command inside its acquired group lock. */
export function applySocketPlaybackAction(
    groupId: string,
    userId: string,
    data: SocketPlaybackRequest,
    fence: GroupMutationFence,
): void {
    if (data.action === "play") {
        groupManager.play(groupId, userId, fence);
        return;
    }
    if (data.action === "pause") {
        groupManager.pause(groupId, userId, fence);
        return;
    }
    if (data.action === "next") {
        groupManager.next(groupId, userId, fence);
        return;
    }
    if (data.action === "previous") {
        groupManager.previous(groupId, userId, fence);
        return;
    }
    if (data.action === "seek") {
        applySeek(groupId, userId, data, fence);
        return;
    }
    if (data.action === "set-track") {
        if (typeof data.index !== "number") {
            throw new GroupError("INVALID", "index required for set-track");
        }
        groupManager.setTrack(groupId, userId, data.index, true, fence);
        return;
    }
    throw new GroupError("INVALID", `Unknown action: ${data.action}`);
}
