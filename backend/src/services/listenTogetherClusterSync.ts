import { randomUUID } from "crypto";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import type { GroupSnapshot } from "./listenTogetherManager";
import { config } from "../config";

const LISTEN_TOGETHER_STATE_SYNC_ENABLED =
    config.listenTogether.stateSyncEnabled;
const LISTEN_TOGETHER_STATE_SYNC_CHANNEL =
    config.listenTogether.stateSyncChannel;

/** Exact committed membership shared without playback state. */
export interface ClusterGroupMembership {
    hostUserId: string;
    members: GroupSnapshot["members"];
}

interface ListenTogetherStateSyncEvent {
    type: "group-snapshot" | "group-membership" | "group-ended";
    groupId: string;
    originNodeId: string;
    snapshot?: GroupSnapshot;
    membership?: ClusterGroupMembership;
    ts: number;
}

type SnapshotHandler = (snapshot: GroupSnapshot) => void;
type GroupEndedHandler = (groupId: string) => void;
type MembershipHandler = (
    groupId: string,
    membership: ClusterGroupMembership,
) => void;

function isClusterMembership(value: unknown): value is ClusterGroupMembership {
    if (!value || typeof value !== "object") return false;
    const membership = value as Record<string, unknown>;
    if (
        typeof membership.hostUserId !== "string" ||
        !Array.isArray(membership.members) ||
        membership.members.length > 10_000
    ) {
        return false;
    }
    return membership.members.every((member) => {
        if (!member || typeof member !== "object") return false;
        const candidate = member as Record<string, unknown>;
        return (
            typeof candidate.userId === "string" &&
            typeof candidate.username === "string" &&
            typeof candidate.joinedAt === "string" &&
            Number.isFinite(Date.parse(candidate.joinedAt)) &&
            typeof candidate.isHost === "boolean" &&
            typeof candidate.isConnected === "boolean"
        );
    });
}

class ListenTogetherClusterSync {
    private readonly nodeId = randomUUID();
    private pubClient: ReturnType<typeof createIORedisClient> | null = null;
    private subClient: ReturnType<typeof createIORedisClient> | null = null;
    private started = false;
    private handler: SnapshotHandler | null = null;
    private endedHandler: GroupEndedHandler | null = null;
    private membershipHandler: MembershipHandler | null = null;

    isEnabled(): boolean {
        return LISTEN_TOGETHER_STATE_SYNC_ENABLED;
    }

    async start(
        handler: SnapshotHandler,
        endedHandler?: GroupEndedHandler,
        membershipHandler?: MembershipHandler,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED) {
            return;
        }

        if (this.started) {
            this.handler = handler;
            this.endedHandler = endedHandler ?? null;
            this.membershipHandler = membershipHandler ?? null;
            return;
        }

        this.handler = handler;
        this.endedHandler = endedHandler ?? null;
        this.membershipHandler = membershipHandler ?? null;
        this.pubClient = createIORedisClient("listen-together-state-sync-pub");
        this.subClient = this.pubClient.duplicate();

        this.subClient.on("message", (channel, message) => {
            if (channel !== LISTEN_TOGETHER_STATE_SYNC_CHANNEL) return;
            this.handleMessage(message);
        });

        await this.subClient.subscribe(LISTEN_TOGETHER_STATE_SYNC_CHANNEL);
        this.started = true;
        logger.info(
            `[ListenTogether/StateSync] Enabled on channel "${LISTEN_TOGETHER_STATE_SYNC_CHANNEL}" (node=${this.nodeId})`,
        );
    }

    async publishSnapshot(
        groupId: string,
        snapshot: GroupSnapshot,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED || !this.pubClient) {
            return;
        }

        const payload: ListenTogetherStateSyncEvent = {
            type: "group-snapshot",
            groupId,
            originNodeId: this.nodeId,
            snapshot,
            ts: Date.now(),
        };

        try {
            await this.pubClient.publish(
                LISTEN_TOGETHER_STATE_SYNC_CHANNEL,
                JSON.stringify(payload),
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateSync] Failed to publish snapshot for group ${groupId}`,
                err,
            );
            throw err;
        }
    }

    async publishEnded(groupId: string): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED || !this.pubClient) {
            return;
        }

        const payload: ListenTogetherStateSyncEvent = {
            type: "group-ended",
            groupId,
            originNodeId: this.nodeId,
            ts: Date.now(),
        };

        try {
            await this.pubClient.publish(
                LISTEN_TOGETHER_STATE_SYNC_CHANNEL,
                JSON.stringify(payload),
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateSync] Failed to publish end for group ${groupId}`,
                err,
            );
            throw err;
        }
    }

    async publishMembership(
        groupId: string,
        membership: ClusterGroupMembership,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED || !this.pubClient) {
            return;
        }

        const payload: ListenTogetherStateSyncEvent = {
            type: "group-membership",
            groupId,
            originNodeId: this.nodeId,
            membership,
            ts: Date.now(),
        };
        try {
            await this.pubClient.publish(
                LISTEN_TOGETHER_STATE_SYNC_CHANNEL,
                JSON.stringify(payload),
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateSync] Failed to publish membership for group ${groupId}`,
                err,
            );
            throw err;
        }
    }

    async stop(): Promise<void> {
        this.handler = null;
        this.endedHandler = null;
        this.membershipHandler = null;

        if (this.subClient) {
            try {
                await this.subClient.unsubscribe(
                    LISTEN_TOGETHER_STATE_SYNC_CHANNEL,
                );
            } catch {
                // ignore unsubscribe failures during shutdown
            }
            this.subClient.disconnect();
            this.subClient = null;
        }

        if (this.pubClient) {
            this.pubClient.disconnect();
            this.pubClient = null;
        }

        this.started = false;
    }

    private handleMessage(rawMessage: string): void {
        if (!this.handler) {
            return;
        }

        try {
            const parsed = JSON.parse(
                rawMessage,
            ) as ListenTogetherStateSyncEvent;
            if (parsed.originNodeId === this.nodeId) return;
            if (parsed.type === "group-ended") {
                if (typeof parsed.groupId !== "string") return;
                this.endedHandler?.(parsed.groupId);
                return;
            }
            if (parsed.type === "group-membership") {
                if (
                    typeof parsed.groupId !== "string" ||
                    !isClusterMembership(parsed.membership)
                ) {
                    return;
                }
                this.membershipHandler?.(parsed.groupId, parsed.membership);
                return;
            }
            if (parsed.type !== "group-snapshot") return;
            if (!parsed.snapshot || parsed.groupId !== parsed.snapshot.id)
                return;

            this.handler(parsed.snapshot);
        } catch (err) {
            logger.warn(
                "[ListenTogether/StateSync] Ignoring invalid sync message",
            );
        }
    }
}

export const listenTogetherClusterSync = new ListenTogetherClusterSync();
