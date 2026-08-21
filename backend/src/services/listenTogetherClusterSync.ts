import { randomUUID } from "crypto";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import type { GroupSnapshot } from "./listenTogetherManager";
import { config } from "../config";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import { withLocalGroupMutationBoundary } from "./listenTogetherMutationLock";

const LISTEN_TOGETHER_STATE_SYNC_ENABLED =
    config.listenTogether.stateSyncEnabled;
const LISTEN_TOGETHER_STATE_SYNC_CHANNEL =
    config.listenTogether.stateSyncChannel;

/** Exact committed membership shared without playback state. */
export interface ClusterGroupMembership {
    hostUserId: string;
    members: GroupSnapshot["members"];
}

/** Ordering identity attached to one lock-owned cluster publication. */
export interface ClusterPublicationMetadata {
    fencingToken: number;
    publicationId: string;
}

interface ListenTogetherStateSyncEvent {
    type: "group-snapshot" | "group-membership" | "group-ended";
    groupId: string;
    originNodeId: string;
    fencingToken: number;
    publicationId: string;
    snapshot?: GroupSnapshot;
    membership?: ClusterGroupMembership;
    ts: number;
}

interface ClusterEventWatermark {
    fencingToken: number;
    publicationIds: Set<string>;
    lastTouchedAtMs: number;
}

const MAX_PUBLICATION_IDS_PER_FENCE = 16;
const MAX_EVENT_WATERMARK_GROUPS = 10_000;
const EVENT_WATERMARK_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;

type DeferredClusterEffect = () => void | Promise<void>;
type SnapshotHandler = (
    snapshot: GroupSnapshot,
) => DeferredClusterEffect | Promise<DeferredClusterEffect>;
type GroupEndedHandler = (
    groupId: string,
) => DeferredClusterEffect | Promise<DeferredClusterEffect>;
type MembershipHandler = (
    groupId: string,
    membership: ClusterGroupMembership,
    metadata: ClusterPublicationMetadata,
) => DeferredClusterEffect | Promise<DeferredClusterEffect>;
type RecoveryHandler = (
    groupId: string,
    snapshot: GroupSnapshot | null,
) => void | Promise<void>;

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

/** Redis pub/sub synchronization with per-group fencing and deduplication. */
export class ListenTogetherClusterSync {
    private readonly nodeId = randomUUID();
    private pubClient: ReturnType<typeof createIORedisClient> | null = null;
    private subClient: ReturnType<typeof createIORedisClient> | null = null;
    private started = false;
    private handler: SnapshotHandler | null = null;
    private endedHandler: GroupEndedHandler | null = null;
    private membershipHandler: MembershipHandler | null = null;
    private recoveryHandler: RecoveryHandler | null = null;
    private readonly eventWatermarks = new Map<string, ClusterEventWatermark>();

    isEnabled(): boolean {
        return LISTEN_TOGETHER_STATE_SYNC_ENABLED;
    }

    async start(
        handler: SnapshotHandler,
        endedHandler?: GroupEndedHandler,
        membershipHandler?: MembershipHandler,
        recoveryHandler?: RecoveryHandler,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED) {
            return;
        }

        if (this.started) {
            this.handler = handler;
            this.endedHandler = endedHandler ?? null;
            this.membershipHandler = membershipHandler ?? null;
            this.recoveryHandler = recoveryHandler ?? null;
            return;
        }

        this.handler = handler;
        this.endedHandler = endedHandler ?? null;
        this.membershipHandler = membershipHandler ?? null;
        this.recoveryHandler = recoveryHandler ?? null;
        this.pubClient = createIORedisClient("listen-together-state-sync-pub");
        this.subClient = this.pubClient.duplicate();

        this.subClient.on("message", (channel, message) => {
            if (channel !== LISTEN_TOGETHER_STATE_SYNC_CHANNEL) return;
            void this.handleMessage(message).catch((error) => {
                logger.warn(
                    "[ListenTogether/StateSync] Failed cluster authority validation",
                    error,
                );
            });
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
        metadata?: ClusterPublicationMetadata,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED || !this.pubClient) {
            return;
        }

        const payload: ListenTogetherStateSyncEvent = {
            type: "group-snapshot",
            groupId,
            originNodeId: this.nodeId,
            ...this.resolveMetadata(metadata),
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

    async publishEnded(
        groupId: string,
        metadata?: ClusterPublicationMetadata,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED || !this.pubClient) {
            return;
        }

        const payload: ListenTogetherStateSyncEvent = {
            type: "group-ended",
            groupId,
            originNodeId: this.nodeId,
            ...this.resolveMetadata(metadata),
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
        metadata?: ClusterPublicationMetadata,
    ): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED || !this.pubClient) {
            return;
        }

        const payload: ListenTogetherStateSyncEvent = {
            type: "group-membership",
            groupId,
            originNodeId: this.nodeId,
            ...this.resolveMetadata(metadata),
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
        this.recoveryHandler = null;

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
        this.eventWatermarks.clear();
    }

    private async handleMessage(rawMessage: string): Promise<void> {
        if (!this.handler) return;
        const event = this.parseEvent(rawMessage);
        if (!event || event.originNodeId === this.nodeId) return;
        await withLocalGroupMutationBoundary(event.groupId, () =>
            this.consumeEvent(event),
        );
    }

    private parseEvent(
        rawMessage: string,
    ): ListenTogetherStateSyncEvent | null {
        try {
            const event = JSON.parse(
                rawMessage,
            ) as ListenTogetherStateSyncEvent;
            return this.validEventPayload(event) ? event : null;
        } catch {
            logger.warn(
                "[ListenTogether/StateSync] Ignoring invalid sync message",
            );
            return null;
        }
    }

    private validEventPayload(event: ListenTogetherStateSyncEvent): boolean {
        if (typeof event.groupId !== "string") return false;
        if (event.type === "group-ended") return true;
        if (event.type === "group-membership") {
            return isClusterMembership(event.membership);
        }
        return (
            event.type === "group-snapshot" &&
            Boolean(event.snapshot) &&
            event.groupId === event.snapshot?.id
        );
    }

    private async consumeEvent(
        event: ListenTogetherStateSyncEvent,
    ): Promise<void> {
        if (!(await this.isAuthoritative(event))) return;
        if (!this.wouldAcceptEvent(event)) return;
        const effect = await this.applyEvent(event);
        if (!(await this.isAuthoritative(event))) {
            await this.reloadAuthority(event.groupId);
            return;
        }
        if (!this.acceptEvent(event)) return;
        await effect?.();
        if (event.type === "group-ended") {
            this.eventWatermarks.delete(event.groupId);
        }
    }

    private async applyEvent(
        event: ListenTogetherStateSyncEvent,
    ): Promise<DeferredClusterEffect | undefined> {
        if (event.type === "group-ended") {
            return this.endedHandler?.(event.groupId);
        }
        if (event.type === "group-membership" && event.membership) {
            const metadata = this.eventMetadata(event);
            if (!metadata) return undefined;
            return this.membershipHandler?.(
                event.groupId,
                event.membership,
                metadata,
            );
        }
        if (event.type === "group-snapshot" && event.snapshot) {
            return this.handler?.(event.snapshot);
        }
    }

    private async reloadAuthority(groupId: string): Promise<void> {
        this.eventWatermarks.delete(groupId);
        const snapshot = await listenTogetherStateStore.getSnapshot(groupId);
        if (this.recoveryHandler) {
            await this.recoveryHandler(groupId, snapshot);
            return;
        }
        if (snapshot) {
            const effect = await this.handler?.(snapshot);
            await effect?.();
            return;
        }
        const effect = await this.endedHandler?.(groupId);
        await effect?.();
    }

    private async isAuthoritative(
        event: ListenTogetherStateSyncEvent,
    ): Promise<boolean> {
        const metadata = this.eventMetadata(event);
        if (!metadata) return false;
        // Local watermarks are only a bounded replay cache. Redis state-store
        // fencing and snapshot ordering remain authoritative across restarts.
        return listenTogetherStateStore.validatePublication(
            event.groupId,
            event.type,
            metadata.fencingToken,
            event.snapshot,
        );
    }

    private resolveMetadata(
        metadata?: ClusterPublicationMetadata,
    ): ClusterPublicationMetadata {
        return (
            metadata ?? {
                fencingToken: 0,
                publicationId: randomUUID(),
            }
        );
    }

    private acceptEvent(event: ListenTogetherStateSyncEvent): boolean {
        const metadata = this.eventMetadata(event);
        if (!metadata) return false;
        const now = Date.now();
        this.expireIdleWatermarks(now);
        const current = this.eventWatermarks.get(event.groupId);
        if (
            !current &&
            this.eventWatermarks.size >= MAX_EVENT_WATERMARK_GROUPS
        ) {
            this.evictOldestWatermark();
        }
        if (!current || metadata.fencingToken > current.fencingToken) {
            this.eventWatermarks.set(event.groupId, {
                fencingToken: metadata.fencingToken,
                publicationIds: new Set([metadata.publicationId]),
                lastTouchedAtMs: now,
            });
            return true;
        }
        if (metadata.fencingToken < current.fencingToken) return false;
        if (current.publicationIds.has(metadata.publicationId)) return false;
        if (current.publicationIds.size >= MAX_PUBLICATION_IDS_PER_FENCE) {
            return false;
        }
        current.publicationIds.add(metadata.publicationId);
        current.lastTouchedAtMs = now;
        return true;
    }

    private wouldAcceptEvent(event: ListenTogetherStateSyncEvent): boolean {
        const metadata = this.eventMetadata(event);
        if (!metadata) return false;
        const current = this.eventWatermarks.get(event.groupId);
        if (!current) return true;
        if (
            Date.now() - current.lastTouchedAtMs >
            EVENT_WATERMARK_IDLE_TTL_MS
        ) {
            return true;
        }
        if (metadata.fencingToken !== current.fencingToken) {
            return metadata.fencingToken > current.fencingToken;
        }
        return (
            !current.publicationIds.has(metadata.publicationId) &&
            current.publicationIds.size < MAX_PUBLICATION_IDS_PER_FENCE
        );
    }

    private expireIdleWatermarks(now: number): void {
        let inspected = 0;
        for (const [groupId, watermark] of this.eventWatermarks) {
            if (inspected >= MAX_EVENT_WATERMARK_GROUPS) return;
            inspected += 1;
            if (now - watermark.lastTouchedAtMs > EVENT_WATERMARK_IDLE_TTL_MS) {
                this.eventWatermarks.delete(groupId);
            }
        }
    }

    private evictOldestWatermark(): void {
        let oldestGroupId: string | null = null;
        let oldestTouchedAtMs = Number.POSITIVE_INFINITY;
        let inspected = 0;
        for (const [groupId, watermark] of this.eventWatermarks) {
            if (inspected >= MAX_EVENT_WATERMARK_GROUPS) break;
            inspected += 1;
            if (watermark.lastTouchedAtMs < oldestTouchedAtMs) {
                oldestGroupId = groupId;
                oldestTouchedAtMs = watermark.lastTouchedAtMs;
            }
        }
        if (oldestGroupId) this.eventWatermarks.delete(oldestGroupId);
    }

    private eventMetadata(
        event: ListenTogetherStateSyncEvent,
    ): ClusterPublicationMetadata | null {
        const fencingToken = event.fencingToken ?? 0;
        const publicationId =
            event.publicationId ??
            `${event.originNodeId}:${event.ts}:${event.type}`;
        if (!Number.isSafeInteger(fencingToken) || fencingToken < 0)
            return null;
        if (
            typeof publicationId !== "string" ||
            publicationId.length < 1 ||
            publicationId.length > 128
        ) {
            return null;
        }
        return { fencingToken, publicationId };
    }
}

export const listenTogetherClusterSync = new ListenTogetherClusterSync();
