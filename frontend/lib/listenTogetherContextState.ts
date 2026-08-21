import type { Track } from "@/lib/audio-state-context";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import type {
    AvailabilityItem,
    GroupSnapshot,
    QueueTrackInput,
    SyncQueueItem,
} from "@/lib/listen-together-socket";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import {
    normalizeCanonicalMediaProviderIdentity,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";

/** Convert a synchronized queue item to a local player track. */
export function toLocalTrack(
    item: SyncQueueItem,
    availability?: AvailabilityItem,
): Track {
    const effectiveSource = availability?.source ?? item.originSource;
    const localTrackId = availability?.localTrackId ?? item.localTrackId;
    const tidalTrackId =
        availability?.tidalTrackId ??
        item.provider?.tidalTrackId ??
        item.tidalTrackId;
    const youtubeVideoId =
        availability?.youtubeVideoId ??
        item.provider?.youtubeVideoId ??
        item.youtubeVideoId;
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: effectiveSource === "local" ? "local" : item.mediaSource,
        providerTrackId: item.provider?.providerTrackId,
        tidalTrackId: effectiveSource === "youtube" ? undefined : tidalTrackId,
        youtubeVideoId:
            effectiveSource === "tidal" ? undefined : youtubeVideoId,
        youtubeAudioFormat:
            item.provider?.youtubeAudioFormat ?? item.youtubeAudioFormat,
        streamSource:
            effectiveSource === "local"
                ? undefined
                : (effectiveSource ?? item.streamSource),
    });
    return {
        id: effectiveSource === "local" ? (localTrackId ?? item.id) : item.id,
        title: item.title,
        duration: item.duration,
        artist: { id: item.artist.id, name: item.artist.name },
        album: {
            id: item.album.id,
            title: item.album.title,
            coverArt: item.album.coverArt ?? undefined,
        },
        mediaSource: provider.source,
        provider,
        ...toLegacyStreamFields(provider),
    };
}

export type ListenTogetherMembershipPendingOperation = "create" | "join" | null;

/** Resolve whether a cold-path membership operation is pending. */
export function resolveListenTogetherMembershipPendingState(
    operation: ListenTogetherMembershipPendingOperation,
): boolean {
    return operation === "create" || operation === "join";
}

export type ListenTogetherReadyReportRecoveryAction =
    | "retry"
    | "terminal-retry"
    | "recover";

/** Select the next ready-report recovery action. */
export function resolveListenTogetherReadyReportRecoveryAction(input: {
    elapsedMs: number;
    maxWaitMs: number;
    terminalRetryAttempted: boolean;
}): ListenTogetherReadyReportRecoveryAction {
    if (input.elapsedMs < input.maxWaitMs) return "retry";
    return input.terminalRetryAttempted ? "recover" : "terminal-retry";
}

/** Convert a local music queue into the Listen Together API shape. */
export function extractQueueTrackInputs(
    queue: readonly QueueItem[],
    currentTrack: Track | null,
): { queueTracks: QueueTrackInput[]; currentTrackId?: string } {
    const source: readonly QueueItem[] =
        queue.length > 0 ? queue : currentTrack ? [currentTrack] : [];
    const queueTracks: QueueTrackInput[] = [];
    for (const track of source) {
        if (isEpisodeQueueItem(track)) continue;
        try {
            queueTracks.push(toAddToPlaylistRef(track));
        } catch {
            continue;
        }
    }
    const currentTrackId =
        currentTrack && queueTracks.length > 0 ? currentTrack.id : undefined;
    return { queueTracks, currentTrackId };
}

function isMembershipVersion(value: number | undefined): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
}

/** Tracks the highest membership authority observed for the active group. */
export class ListenTogetherMembershipOrdering {
    private groupId: string | null = null;
    private version: number | null = null;

    clear(): void {
        this.groupId = null;
        this.version = null;
    }

    adopt(groupId: string, membershipVersion?: number): void {
        this.groupId = groupId;
        this.version = isMembershipVersion(membershipVersion)
            ? membershipVersion
            : null;
    }

    accepts(groupId: string, membershipVersion?: number): boolean {
        if (this.groupId !== groupId) {
            this.adopt(groupId, membershipVersion);
            return true;
        }
        if (!isMembershipVersion(membershipVersion)) return true;
        if (this.version !== null && membershipVersion < this.version) {
            return false;
        }
        this.version =
            this.version === null
                ? membershipVersion
                : Math.max(this.version, membershipVersion);
        return true;
    }

    decideEvent(
        groupId: string,
        membershipVersion?: number,
    ): "apply" | "ignore" | "resync" {
        if (
            this.groupId === groupId &&
            this.version !== null &&
            !isMembershipVersion(membershipVersion)
        ) {
            return "resync";
        }
        return this.accepts(groupId, membershipVersion) ? "apply" : "ignore";
    }

    preserveNewerMembership(
        snapshot: GroupSnapshot,
        previous: GroupSnapshot | null,
        accepted: boolean,
    ): GroupSnapshot {
        if (accepted) return snapshot;
        if (!previous || previous.id !== snapshot.id) return snapshot;
        return {
            ...snapshot,
            hostUserId: previous.hostUserId,
            membershipVersion: this.version ?? previous.membershipVersion,
            members: previous.members,
        };
    }
}

/** Identifies ownership of one generation-scoped group resync. */
export interface ListenTogetherResyncLease {
    groupId: string;
    generation: number;
}

/** Owns single-flight group resyncs for the current membership generation. */
export class ListenTogetherResyncOwnership {
    private generation = 0;
    private readonly inFlightGenerations = new Map<string, number>();

    advance(): void {
        this.generation += 1;
        this.inFlightGenerations.clear();
    }

    claim(
        groupId: string | null | undefined,
    ): ListenTogetherResyncLease | null {
        if (
            !groupId ||
            this.inFlightGenerations.get(groupId) === this.generation
        ) {
            return null;
        }
        this.inFlightGenerations.set(groupId, this.generation);
        return { groupId, generation: this.generation };
    }

    owns(lease: ListenTogetherResyncLease): boolean {
        return (
            lease.generation === this.generation &&
            this.inFlightGenerations.get(lease.groupId) === lease.generation
        );
    }

    release(lease: ListenTogetherResyncLease): void {
        if (this.owns(lease)) {
            this.inFlightGenerations.delete(lease.groupId);
        }
    }
}

/** Start a generation-scoped single-flight group resync. */
export function scheduleGenerationScopedListenTogetherResync(input: {
    groupId: string | null | undefined;
    ownership: ListenTogetherResyncOwnership;
    request: (groupId: string) => Promise<void>;
    isTerminalError: (error: unknown) => boolean;
    onTerminalError: (groupId: string) => void;
    onTransientError: (error: unknown) => void;
}): void {
    const lease = input.ownership.claim(input.groupId);
    if (!lease) return;
    void input
        .request(lease.groupId)
        .catch((error: unknown) => {
            if (!input.ownership.owns(lease)) return;
            if (input.isTerminalError(error)) {
                input.onTerminalError(lease.groupId);
                return;
            }
            input.onTransientError(error);
        })
        .finally(() => input.ownership.release(lease));
}
