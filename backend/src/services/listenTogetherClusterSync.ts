import { randomUUID } from "crypto";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import type { GroupSnapshot } from "./listenTogetherTypes";
import { config } from "../config";
import { listenTogetherStateStore } from "./listenTogetherStateStore";
import { withLocalGroupMutationBoundary } from "./listenTogetherMutationLock";
import { withListenTogetherDeadlineAt } from "./listenTogetherDeadline";

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

/** Durable user identity and bounded group scope for socket revocation. */
export interface ClusterUserRevocation {
    userId: string;
    groupIds: string[] | "all-for-user";
}

interface ListenTogetherStateSyncEvent {
    type:
        | "group-snapshot"
        | "group-membership"
        | "group-ended"
        | "user-revocation";
    groupId: string;
    originNodeId: string;
    fencingToken: number;
    publicationId: string;
    snapshot?: GroupSnapshot;
    membership?: ClusterGroupMembership;
    revocation?: ClusterUserRevocation;
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
const RECONNECT_RECONCILIATION_DEADLINE_MS = 10_000;

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
type UserRevocationHandler = (
    revocation: ClusterUserRevocation,
    metadata: ClusterPublicationMetadata,
) => DeferredClusterEffect | Promise<DeferredClusterEffect>;
type ReconciliationHandler = (scope: {
    signal: AbortSignal;
    deadlineAtMs: number;
}) => void | Promise<void>;

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

function isUserRevocation(value: unknown): value is ClusterUserRevocation {
    if (!value || typeof value !== "object") return false;
    const revocation = value as Record<string, unknown>;
    if (
        typeof revocation.userId !== "string" ||
        revocation.userId.length < 1 ||
        revocation.userId.length > 128
    ) {
        return false;
    }
    if (revocation.groupIds === "all-for-user") return true;
    return (
        Array.isArray(revocation.groupIds) &&
        revocation.groupIds.length > 0 &&
        revocation.groupIds.length <= 400 &&
        revocation.groupIds.every(
            (groupId) =>
                typeof groupId === "string" &&
                groupId.length > 0 &&
                groupId.length <= 128,
        )
    );
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
    private userRevocationHandler: UserRevocationHandler | null = null;
    private reconciliationHandler: ReconciliationHandler | null = null;
    private reconciliationFlight: Promise<void> | null = null;
    private reconciliationRerunRequested = false;
    private readonly eventWatermarks = new Map<string, ClusterEventWatermark>();

    isEnabled(): boolean {
        return LISTEN_TOGETHER_STATE_SYNC_ENABLED;
    }

    async start(
        handler: SnapshotHandler,
        endedHandler?: GroupEndedHandler,
        membershipHandler?: MembershipHandler,
        recoveryHandler?: RecoveryHandler,
        userRevocationHandler?: UserRevocationHandler,
        reconciliationHandler?: ReconciliationHandler,
    ): Promise<void> {
        this.configureHandlers(
            handler,
            endedHandler,
            membershipHandler,
            recoveryHandler,
            userRevocationHandler,
            reconciliationHandler,
        );
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED) {
            return;
        }

        if (this.started) {
            return;
        }

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
        this.subClient.on("ready", () => {
            if (!this.started) return;
            this.enqueueSubscriptionReconciliation();
        });

        await this.subscribeAndReconcile();
        this.started = true;
        logger.info(
            `[ListenTogether/StateSync] Enabled on channel "${LISTEN_TOGETHER_STATE_SYNC_CHANNEL}" (node=${this.nodeId})`,
        );
    }

    /** Evict this pod before any best-effort cross-pod publication. */
    async revokeLocalUser(
        revocation: ClusterUserRevocation,
        metadata?: ClusterPublicationMetadata,
    ): Promise<void> {
        if (!this.userRevocationHandler) {
            throw new Error(
                "Listen Together local revocation is not initialized",
            );
        }
        const effect = await this.userRevocationHandler(
            revocation,
            this.resolveMetadata(metadata),
        );
        await effect();
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

    async publishUserRevocation(
        userId: string,
        groupIds: ClusterUserRevocation["groupIds"],
        metadata?: ClusterPublicationMetadata,
    ): Promise<void> {
        // Single-pod mode is complete after revokeLocalUser(); there is no peer
        // transport to acknowledge, so publication is an explicit no-op.
        if (!LISTEN_TOGETHER_STATE_SYNC_ENABLED) return;
        if (!this.pubClient) {
            throw new Error(
                "Listen Together cluster publication is not initialized",
            );
        }
        const payload: ListenTogetherStateSyncEvent = {
            type: "user-revocation",
            groupId:
                groupIds === "all-for-user"
                    ? "__all-for-user__"
                    : (groupIds[0] ?? "__all-for-user__"),
            originNodeId: this.nodeId,
            ...this.resolveMetadata(metadata),
            revocation: { userId, groupIds },
            ts: Date.now(),
        };
        try {
            await this.pubClient.publish(
                LISTEN_TOGETHER_STATE_SYNC_CHANNEL,
                JSON.stringify(payload),
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateSync] Failed to publish revocation for user ${userId}`,
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
        this.userRevocationHandler = null;
        this.reconciliationHandler = null;
        this.reconciliationRerunRequested = false;

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

    private configureHandlers(
        handler: SnapshotHandler,
        endedHandler?: GroupEndedHandler,
        membershipHandler?: MembershipHandler,
        recoveryHandler?: RecoveryHandler,
        userRevocationHandler?: UserRevocationHandler,
        reconciliationHandler?: ReconciliationHandler,
    ): void {
        this.handler = handler;
        this.endedHandler = endedHandler ?? null;
        this.membershipHandler = membershipHandler ?? null;
        this.recoveryHandler = recoveryHandler ?? null;
        this.userRevocationHandler = userRevocationHandler ?? null;
        this.reconciliationHandler = reconciliationHandler ?? null;
    }

    private async subscribeAndReconcile(): Promise<void> {
        if (!this.subClient) {
            throw new Error("Listen Together subscriber is not initialized");
        }
        const controller = new AbortController();
        const deadlineAtMs = Date.now() + RECONNECT_RECONCILIATION_DEADLINE_MS;
        const timer = setTimeout(
            () =>
                controller.abort(new Error("Reconnect audit deadline expired")),
            RECONNECT_RECONCILIATION_DEADLINE_MS,
        );
        timer.unref?.();
        try {
            const subscription = this.subClient.subscribe(
                LISTEN_TOGETHER_STATE_SYNC_CHANNEL,
            );
            await this.awaitOwnedReconciliationOperation(
                subscription,
                "Listen Together cluster subscription",
                deadlineAtMs,
                controller,
            );
            const reconciliation = Promise.resolve(
                this.reconciliationHandler?.({
                    signal: controller.signal,
                    deadlineAtMs,
                }),
            );
            await this.awaitOwnedReconciliationOperation(
                reconciliation,
                "Listen Together reconnect reconciliation",
                deadlineAtMs,
                controller,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    private enqueueSubscriptionReconciliation(): void {
        if (this.reconciliationFlight) {
            this.reconciliationRerunRequested = true;
            return;
        }
        const flight = this.subscribeAndReconcile();
        this.reconciliationFlight = flight;
        void flight.then(
            () => this.finishReconciliationFlight(flight),
            (error) => this.finishReconciliationFlight(flight, error),
        );
    }

    private finishReconciliationFlight(
        flight: Promise<void>,
        error?: unknown,
    ): void {
        if (this.reconciliationFlight !== flight) return;
        this.reconciliationFlight = null;
        if (error !== undefined) {
            logger.warn(
                "[ListenTogether/StateSync] Reconnect reconciliation failed",
                error,
            );
        }
        const rerunRequested = this.reconciliationRerunRequested;
        this.reconciliationRerunRequested = false;
        if (rerunRequested && this.started) {
            this.enqueueSubscriptionReconciliation();
        }
    }

    private async awaitOwnedReconciliationOperation<T>(
        operation: Promise<T>,
        operationName: string,
        deadlineAtMs: number,
        controller: AbortController,
    ): Promise<T> {
        try {
            return await withListenTogetherDeadlineAt(
                operation,
                operationName,
                deadlineAtMs,
                controller.signal,
            );
        } catch (error) {
            controller.abort(error);
            try {
                await operation;
            } catch {
                // Preserve the deadline/abort error after owning settlement.
            }
            throw error;
        }
    }

    private async handleMessage(rawMessage: string): Promise<void> {
        if (!this.handler) return;
        const event = this.parseEvent(rawMessage);
        if (!event) return;
        if (event.type === "user-revocation") {
            await this.consumeUserRevocation(event);
            return;
        }
        if (event.originNodeId === this.nodeId) return;
        if (!event.groupId) return;
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
        if (event.type === "user-revocation") {
            return (
                typeof event.groupId === "string" &&
                isUserRevocation(event.revocation)
            );
        }
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

    private async consumeUserRevocation(
        event: ListenTogetherStateSyncEvent,
    ): Promise<void> {
        if (!event.revocation || !this.userRevocationHandler) return;
        const metadata = this.eventMetadata(event);
        if (!metadata) return;
        // Identity eviction is idempotent. Replays and cross-group ordering are
        // safe because a revoked socket no longer has an attached group.
        const effect = await this.userRevocationHandler(
            event.revocation,
            metadata,
        );
        await effect();
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
        if (event.type === "user-revocation") return false;
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
