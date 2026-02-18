import { randomUUID } from "crypto";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import type { GroupSnapshot } from "./listenTogetherManager";

const LISTEN_TOGETHER_STATE_SYNC_ENABLED =
    process.env.LISTEN_TOGETHER_STATE_SYNC_ENABLED !== "false";
const LISTEN_TOGETHER_STATE_SYNC_CHANNEL =
    process.env.LISTEN_TOGETHER_STATE_SYNC_CHANNEL ||
    "listen-together:state-sync";

interface ListenTogetherStateSyncEvent {
    type: "group-snapshot";
    groupId: string;
    originNodeId: string;
    snapshot: GroupSnapshot;
    ts: number;
}

type SnapshotHandler = (snapshot: GroupSnapshot) => void;

class ListenTogetherClusterSync {
    private readonly nodeId = randomUUID();
    private pubClient: ReturnType<typeof createIORedisClient> | null = null;
    private subClient: ReturnType<typeof createIORedisClient> | null = null;
    private started = false;
    private handler: SnapshotHandler | null = null;

    isEnabled(): boolean {
        return LISTEN_TOGETHER_STATE_SYNC_ENABLED;
    }

    async start(handler: SnapshotHandler): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED) {
            return;
        }

        if (this.started) {
            this.handler = handler;
            return;
        }

        this.handler = handler;
        this.pubClient = createIORedisClient("listen-together-state-sync-pub");
        this.subClient = this.pubClient.duplicate();

        this.subClient.on("message", (channel, message) => {
            if (channel !== LISTEN_TOGETHER_STATE_SYNC_CHANNEL) return;
            this.handleMessage(message);
        });

        await this.subClient.subscribe(LISTEN_TOGETHER_STATE_SYNC_CHANNEL);
        this.started = true;
        logger.info(
            `[ListenTogether/StateSync] Enabled on channel "${LISTEN_TOGETHER_STATE_SYNC_CHANNEL}" (node=${this.nodeId})`
        );
    }

    async publishSnapshot(groupId: string, snapshot: GroupSnapshot): Promise<void> {
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
                JSON.stringify(payload)
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateSync] Failed to publish snapshot for group ${groupId}`,
                err
            );
        }
    }

    async stop(): Promise<void> {
        this.handler = null;

        if (this.subClient) {
            try {
                await this.subClient.unsubscribe(LISTEN_TOGETHER_STATE_SYNC_CHANNEL);
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
            const parsed = JSON.parse(rawMessage) as ListenTogetherStateSyncEvent;
            if (parsed.type !== "group-snapshot") return;
            if (parsed.originNodeId === this.nodeId) return;
            if (!parsed.snapshot || parsed.groupId !== parsed.snapshot.id) return;

            this.handler(parsed.snapshot);
        } catch (err) {
            logger.warn("[ListenTogether/StateSync] Ignoring invalid sync message");
        }
    }
}

export const listenTogetherClusterSync = new ListenTogetherClusterSync();
