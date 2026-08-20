import type {
    GroupSnapshot,
    PlaybackDelta,
    QueueDelta,
} from "./listenTogetherManager";

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
