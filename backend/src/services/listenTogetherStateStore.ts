import { logger } from "../utils/logger";
import { createIORedisClient } from "../utils/ioredis";
import type { GroupSnapshot } from "./listenTogetherManager";
import type { SyncQueueItem } from "./listenTogetherQueueItem";
import { config } from "../config";
import { withListenTogetherDeadline } from "./listenTogetherDeadline";
import type { FencedStateWriteResult } from "./listenTogetherLeaseFencing";
import { GroupError } from "./listenTogetherGroupError";
import { isPlainObject } from "../utils/plainObject";
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
const MAX_INVALID_SNAPSHOT_WARNING_GROUPS = 10_000;
const MAX_SNAPSHOT_MEMBERS = 10_000;
const MAX_SNAPSHOT_QUEUE_ITEMS = 500;
const log = logger.child("ListenTogetherStateStore");

type RolloutQueueItem = SyncQueueItem & {
    actualOriginSource?: "peer";
};

function toRolloutQueueItem(item: SyncQueueItem): RolloutQueueItem {
    const isPeer =
        item.mediaSource === "peer" ||
        item.provider?.source === "peer" ||
        item.streamSource === "peer" ||
        item.originSource === "peer";
    if (!isPeer) return item;
    const { streamSource: _streamSource, ...legacy } = item;
    return {
        ...legacy,
        mediaSource: "local",
        provider: { ...item.provider, source: "local" },
        originSource: "local",
        actualOriginSource: "peer",
    };
}

function toRolloutSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        playback: {
            ...snapshot.playback,
            queue: snapshot.playback.queue.map(toRolloutQueueItem),
        },
    };
}

function restoreRolloutQueueItem(item: SyncQueueItem): SyncQueueItem {
    const rolloutItem = item as RolloutQueueItem;
    if (rolloutItem.actualOriginSource !== "peer") return item;
    const { actualOriginSource: _actualOriginSource, ...restored } =
        rolloutItem;
    return {
        ...restored,
        mediaSource: "peer",
        provider: { ...item.provider, source: "peer" },
        streamSource: "peer",
        originSource: "peer",
    };
}

function restoreRolloutSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        playback: {
            ...snapshot.playback,
            queue: snapshot.playback.queue.map(restoreRolloutQueueItem),
        },
    };
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === "string";
}

function isOptionalNumberOrNull(value: unknown): boolean {
    return value === undefined || value === null || isFiniteNumber(value);
}

function isMediaSource(value: unknown): boolean {
    return (
        value === "local" ||
        value === "peer" ||
        value === "tidal" ||
        value === "youtube" ||
        value === "youtube-direct"
    );
}

function isProvider(value: unknown): boolean {
    if (value === undefined) return true;
    if (!isPlainObject(value) || !isMediaSource(value.source)) return false;
    return (
        isOptionalString(value.providerTrackId) &&
        (value.tidalTrackId === undefined ||
            isFiniteNumber(value.tidalTrackId)) &&
        isOptionalString(value.youtubeVideoId) &&
        (value.youtubeAudioFormat === undefined ||
            value.youtubeAudioFormat === "mp4" ||
            value.youtubeAudioFormat === "webm")
    );
}

function isQueueItem(value: unknown): boolean {
    if (
        !isPlainObject(value) ||
        !isPlainObject(value.artist) ||
        !isPlainObject(value.album)
    ) {
        return false;
    }
    const validSources =
        (value.mediaSource === undefined || isMediaSource(value.mediaSource)) &&
        (value.streamSource === undefined ||
            (isMediaSource(value.streamSource) &&
                value.streamSource !== "local")) &&
        (value.originSource === undefined ||
            value.originSource === "local" ||
            value.originSource === "peer" ||
            value.originSource === "tidal" ||
            value.originSource === "youtube");
    return (
        typeof value.id === "string" &&
        typeof value.title === "string" &&
        isFiniteNumber(value.duration) &&
        value.duration >= 0 &&
        isOptionalNumberOrNull(value.loudnessLufs) &&
        isOptionalNumberOrNull(value.truePeakDb) &&
        typeof value.artist.id === "string" &&
        typeof value.artist.name === "string" &&
        typeof value.album.id === "string" &&
        typeof value.album.title === "string" &&
        (value.album.coverArt === null ||
            typeof value.album.coverArt === "string") &&
        isOptionalNumberOrNull(value.album.albumLoudnessLufs) &&
        isOptionalNumberOrNull(value.album.albumTruePeakDb) &&
        validSources &&
        isProvider(value.provider) &&
        isOptionalString(value.localTrackId) &&
        isOptionalString(value.trackTidalId) &&
        isOptionalString(value.trackYtMusicId) &&
        isOptionalString(value.trackMappingId) &&
        (value.peerOnline === undefined ||
            typeof value.peerOnline === "boolean") &&
        (value.tidalTrackId === undefined ||
            isFiniteNumber(value.tidalTrackId)) &&
        isOptionalString(value.youtubeVideoId) &&
        (value.youtubeAudioFormat === undefined ||
            value.youtubeAudioFormat === "mp4" ||
            value.youtubeAudioFormat === "webm")
    );
}

function isSnapshotPlayback(value: unknown): boolean {
    if (!isPlainObject(value) || !Array.isArray(value.queue)) return false;
    if (
        value.queue.length > MAX_SNAPSHOT_QUEUE_ITEMS ||
        !value.queue.every(isQueueItem)
    ) {
        return false;
    }
    const validCurrentIndex =
        isNonNegativeInteger(value.currentIndex) &&
        (value.queue.length === 0
            ? value.currentIndex === 0
            : value.currentIndex < value.queue.length);
    return (
        validCurrentIndex &&
        typeof value.isPlaying === "boolean" &&
        isFiniteNumber(value.positionMs) &&
        value.positionMs >= 0 &&
        isFiniteNumber(value.serverTime) &&
        value.serverTime >= 0 &&
        isNonNegativeInteger(value.stateVersion) &&
        (value.trackId === null || typeof value.trackId === "string")
    );
}

function isSnapshotMember(value: unknown): boolean {
    if (!isPlainObject(value)) return false;
    return (
        typeof value.userId === "string" &&
        typeof value.username === "string" &&
        typeof value.isHost === "boolean" &&
        typeof value.joinedAt === "string" &&
        Number.isFinite(Date.parse(value.joinedAt)) &&
        typeof value.isConnected === "boolean"
    );
}

function hasSnapshotCollections(snapshot: Record<string, unknown>): boolean {
    if (
        !Array.isArray(snapshot.members) ||
        snapshot.members.length > MAX_SNAPSHOT_MEMBERS ||
        !snapshot.members.every(isSnapshotMember)
    ) {
        return false;
    }
    if (snapshot.readyUserIds === undefined) return true;
    return (
        Array.isArray(snapshot.readyUserIds) &&
        snapshot.readyUserIds.length <= MAX_SNAPSHOT_MEMBERS &&
        snapshot.readyUserIds.every((userId) => typeof userId === "string")
    );
}

function hasSnapshotMetadata(snapshot: Record<string, unknown>): boolean {
    const validMembershipVersion =
        snapshot.membershipVersion === undefined ||
        isNonNegativeInteger(snapshot.membershipVersion);
    const validReadyDeadline =
        snapshot.readyDeadlineMs === undefined ||
        snapshot.readyDeadlineMs === null ||
        (isFiniteNumber(snapshot.readyDeadlineMs) &&
            snapshot.readyDeadlineMs >= 0);
    return (
        typeof snapshot.id === "string" &&
        typeof snapshot.name === "string" &&
        typeof snapshot.joinCode === "string" &&
        (snapshot.groupType === "host-follower" ||
            snapshot.groupType === "collaborative") &&
        (snapshot.visibility === "public" ||
            snapshot.visibility === "private") &&
        typeof snapshot.isActive === "boolean" &&
        typeof snapshot.hostUserId === "string" &&
        validMembershipVersion &&
        (snapshot.syncState === "idle" ||
            snapshot.syncState === "waiting" ||
            snapshot.syncState === "playing" ||
            snapshot.syncState === "paused") &&
        validReadyDeadline
    );
}

function isLikelyGroupSnapshot(value: unknown): value is GroupSnapshot {
    return (
        isPlainObject(value) &&
        hasSnapshotMetadata(value) &&
        hasSnapshotCollections(value) &&
        isSnapshotPlayback(value.playback)
    );
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
    private readonly invalidSnapshotWarningGroups = new Set<string>();

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

        let raw: string | null;
        try {
            raw = await withListenTogetherDeadline(
                this.ensureClient().get(this.key(groupId)),
                "listen together snapshot read",
                LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS,
            );
        } catch (err) {
            log.warn("Snapshot read failed", { groupId, error: err });
            throw err;
        }
        if (raw === null) return null;

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch (error) {
            return this.rejectInvalidSnapshot(groupId, "malformed-json", error);
        }
        if (!isLikelyGroupSnapshot(parsed)) {
            return this.rejectInvalidSnapshot(groupId, "malformed-shape");
        }
        if (parsed.id !== groupId) {
            return this.rejectInvalidSnapshot(groupId, "mismatched-group-id");
        }
        return restoreRolloutSnapshot(parsed);
    }

    private rejectInvalidSnapshot(
        groupId: string,
        reason: string,
        error?: unknown,
    ): never {
        if (!this.invalidSnapshotWarningGroups.has(groupId)) {
            if (
                this.invalidSnapshotWarningGroups.size >=
                MAX_INVALID_SNAPSHOT_WARNING_GROUPS
            ) {
                const oldest = this.invalidSnapshotWarningGroups
                    .values()
                    .next();
                if (!oldest.done) {
                    this.invalidSnapshotWarningGroups.delete(oldest.value);
                }
            }
            this.invalidSnapshotWarningGroups.add(groupId);
            log.warn("Invalid authoritative snapshot", {
                groupId,
                reason,
                error,
            });
        }
        throw new GroupError(
            "UNAVAILABLE",
            "Group state is temporarily unavailable. Please retry.",
        );
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
                JSON.stringify(toRolloutSnapshot(snapshot)),
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
