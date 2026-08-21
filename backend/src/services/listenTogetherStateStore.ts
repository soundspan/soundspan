import { logger } from "../utils/logger";
import { createIORedisClient } from "../utils/ioredis";
import type { GroupSnapshot } from "./listenTogetherManager";
import { config } from "../config";
import { withListenTogetherDeadline } from "./listenTogetherDeadline";
import type { FencedStateWriteResult } from "./listenTogetherLeaseFencing";
import {
    LISTEN_TOGETHER_CLAIM_FENCE_SCRIPT,
    LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT,
    LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT,
    LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT,
} from "./listenTogetherRedisScripts";

const LISTEN_TOGETHER_STATE_STORE_ENABLED =
    config.listenTogether.stateStoreEnabled;
const LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX =
    config.listenTogether.stateStoreKeyPrefix;
const LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS =
    config.listenTogether.stateStoreTtlSeconds;
const LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS =
    config.listenTogether.publicationDeadlineMs;
const LISTEN_TOGETHER_MUTATION_LOCK_PREFIX =
    config.listenTogether.mutationLockPrefix ?? "listen-together:mutation-lock";

function isLikelyGroupSnapshot(value: unknown): value is GroupSnapshot {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.id !== "string") return false;
    if (!snapshot.playback || typeof snapshot.playback !== "object")
        return false;
    if (!Array.isArray(snapshot.members)) return false;
    return true;
}

function snapshotOrdering(snapshot: GroupSnapshot): {
    stateVersion: number;
    serverTime: number;
} {
    const incomingStateVersion = Number(snapshot.playback?.stateVersion);
    const incomingServerTime = Number(snapshot.playback?.serverTime);

    return {
        stateVersion:
            Number.isFinite(incomingStateVersion) && incomingStateVersion >= 0
                ? incomingStateVersion
                : 0,
        serverTime:
            Number.isFinite(incomingServerTime) && incomingServerTime >= 0
                ? incomingServerTime
                : 0,
    };
}

class ListenTogetherStateStore {
    private client: ReturnType<typeof createIORedisClient> | null = null;

    isEnabled(): boolean {
        return LISTEN_TOGETHER_STATE_STORE_ENABLED;
    }

    private ensureClient() {
        if (!this.client) {
            this.client = createIORedisClient("listen-together-state-store");
        }
        return this.client;
    }

    private key(groupId: string): string {
        return `${LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX}:${groupId}`;
    }

    private fenceKey(groupId: string): string {
        return `${LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX}:fence:${groupId}`;
    }

    private fencingCounterKey(groupId: string): string {
        return `${LISTEN_TOGETHER_MUTATION_LOCK_PREFIX}:fencing-token:${groupId}`;
    }

    async getSnapshot(groupId: string): Promise<GroupSnapshot | null> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) {
            return null;
        }

        try {
            const raw = await withListenTogetherDeadline(
                this.ensureClient().get(this.key(groupId)),
                "listen together snapshot read",
                LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
            );
            if (!raw) return null;
            const parsed = JSON.parse(raw) as unknown;
            if (!isLikelyGroupSnapshot(parsed)) {
                logger.warn(
                    `[ListenTogether/StateStore] Ignoring malformed snapshot for group ${groupId}`,
                );
                return null;
            }
            if (parsed.id !== groupId) {
                logger.warn(
                    `[ListenTogether/StateStore] Ignoring snapshot with mismatched id for group ${groupId}`,
                );
                return null;
            }
            return parsed;
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateStore] Failed to fetch snapshot for group ${groupId}`,
                err,
            );
            throw err;
        }
    }

    async setSnapshot(
        groupId: string,
        snapshot: GroupSnapshot,
        fencingToken: number = 0,
    ): Promise<FencedStateWriteResult> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) {
            return "accepted";
        }

        const ordering = snapshotOrdering(snapshot);
        const result = await withListenTogetherDeadline(
            this.ensureClient().eval(
                LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT,
                3,
                this.key(groupId),
                this.fenceKey(groupId),
                this.fencingCounterKey(groupId),
                JSON.stringify(snapshot),
                `${LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS}`,
                `${ordering.stateVersion}`,
                `${ordering.serverTime}`,
                `${fencingToken}`,
            ),
            "listen together snapshot persistence",
            LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
        );
        return result === 1 ? "accepted" : "stale";
    }

    async deleteSnapshot(
        groupId: string,
        fencingToken: number = 0,
    ): Promise<FencedStateWriteResult> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) {
            return "accepted";
        }

        const result = await withListenTogetherDeadline(
            this.ensureClient().eval(
                LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT,
                3,
                this.key(groupId),
                this.fenceKey(groupId),
                this.fencingCounterKey(groupId),
                `${LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS}`,
                `${fencingToken}`,
            ),
            "listen together snapshot deletion",
            LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
        );
        return result === 1 ? "accepted" : "stale";
    }

    async claimFence(
        groupId: string,
        fencingToken: number = 0,
    ): Promise<FencedStateWriteResult> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) return "accepted";

        const result = await withListenTogetherDeadline(
            this.ensureClient().eval(
                LISTEN_TOGETHER_CLAIM_FENCE_SCRIPT,
                2,
                this.fenceKey(groupId),
                this.fencingCounterKey(groupId),
                `${LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS}`,
                `${fencingToken}`,
            ),
            "listen together publication fence",
            LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
        );
        return result === 1 ? "accepted" : "stale";
    }

    /** Check a received cluster event against the durable Redis authority. */
    async validatePublication(
        groupId: string,
        eventType: "group-snapshot" | "group-membership" | "group-ended",
        fencingToken: number,
        snapshot?: GroupSnapshot,
    ): Promise<boolean> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) return false;
        const ordering = snapshot
            ? snapshotOrdering(snapshot)
            : { stateVersion: 0, serverTime: 0 };
        const result = await withListenTogetherDeadline(
            this.ensureClient().eval(
                LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT,
                3,
                this.key(groupId),
                this.fenceKey(groupId),
                this.fencingCounterKey(groupId),
                `${fencingToken}`,
                eventType,
                `${ordering.stateVersion}`,
                `${ordering.serverTime}`,
            ),
            "listen together cluster publication validation",
            LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
        );
        return result === 1;
    }

    stop(): void {
        if (!this.client) return;
        this.client.disconnect();
        this.client = null;
    }
}

export const listenTogetherStateStore = new ListenTogetherStateStore();
