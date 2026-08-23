import { prisma } from "../utils/db";
import {
    federationPeerPresenceSnapshotSchema,
    federationPresenceUserSchema,
    type FederationPeerPresenceSnapshot,
    type FederationPresence,
    type FederationPresenceUser,
} from "../utils/federationPresenceSchemas";
import { redisClient } from "../utils/redis";

const LOCAL_PRESENCE_KEY_PREFIX = "social:presence:user:";
const PEER_PRESENCE_KEY_PREFIX = "federation:social:presence:v1:";
const MAX_EXPORT_USERS = 100;
const MAX_LOCAL_PRESENCE_KEYS = 1_000;
const MAX_PEER_SNAPSHOTS = 500;
const PAUSED_TO_IDLE_CUTOFF_MS = 5 * 60 * 1_000;

type PlaybackState = {
    playbackType: string;
    isPlaying: boolean;
    updatedAt: Date;
    currentIndex: number;
    queue: unknown;
};

type ExportUser = {
    id: string;
    username: string;
    displayName: string | null;
    settings: {
        shareOnlinePresence: boolean;
        shareListeningStatus: boolean;
    } | null;
    playbackStates: PlaybackState[];
};

/** Returns the versioned Redis key for one consumer peer snapshot. */
export function federationPeerPresenceKey(peerId: string): string {
    return `${PEER_PRESENCE_KEY_PREFIX}${peerId}`;
}

async function scanKeys(prefix: string, maximum: number): Promise<string[]> {
    const keys: string[] = [];
    for await (const batch of redisClient.scanIterator({
        MATCH: `${prefix}*`,
        COUNT: 250,
    })) {
        for (let index = 0; index < batch.length; index += 1) {
            const key = batch[index];
            if (typeof key === "string") keys.push(key);
            if (keys.length >= maximum) return keys;
        }
    }
    return keys;
}

async function onlinePresence(): Promise<Map<string, number>> {
    const keys = await scanKeys(
        LOCAL_PRESENCE_KEY_PREFIX,
        MAX_LOCAL_PRESENCE_KEYS,
    );
    if (keys.length === 0) return new Map();
    const values = await redisClient.mGet(keys);
    const online = new Map<string, number>();
    for (let index = 0; index < keys.length; index += 1) {
        const timestamp = Number(values[index]);
        const userId = keys[index].slice(LOCAL_PRESENCE_KEY_PREFIX.length);
        if (userId && Number.isFinite(timestamp) && timestamp > 0) {
            online.set(userId, timestamp);
        }
    }
    return online;
}

function nonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function exportedTrack(state: PlaybackState | undefined) {
    if (
        !state ||
        state.playbackType !== "track" ||
        !Array.isArray(state.queue)
    ) {
        return undefined;
    }
    const value = state.queue[state.currentIndex];
    if (!value || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    const artist =
        item.artist && typeof item.artist === "object"
            ? (item.artist as Record<string, unknown>)
            : null;
    const album =
        item.album && typeof item.album === "object"
            ? (item.album as Record<string, unknown>)
            : null;
    const title = nonEmptyString(item.title);
    const artistName = nonEmptyString(artist?.name);
    const albumTitle = nonEmptyString(album?.title);
    if (!title || !artistName || !albumTitle) return undefined;
    return { title, artist: artistName, album: albumTitle };
}

function exportedStatus(
    state: PlaybackState | undefined,
    hasTrack: boolean,
): FederationPresenceUser["status"] {
    if (!state || state.playbackType !== "track" || !hasTrack) return "idle";
    if (state.isPlaying) return "playing";
    const ageMs = Math.max(0, Date.now() - state.updatedAt.getTime());
    return ageMs <= PAUSED_TO_IDLE_CUTOFF_MS ? "paused" : "idle";
}

function exportUser(
    user: ExportUser,
    heartbeatMs: number,
): FederationPresenceUser | null {
    const settings = user.settings;
    if (settings?.shareOnlinePresence !== true) {
        return null;
    }
    const state = user.playbackStates[0];
    const track = settings.shareListeningStatus
        ? exportedTrack(state)
        : undefined;
    const candidate = {
        username: user.username,
        ...(user.displayName ? { displayName: user.displayName } : {}),
        status: settings.shareListeningStatus
            ? exportedStatus(state, track !== undefined)
            : "idle",
        ...(track ? { track } : {}),
        updatedAt: new Date(heartbeatMs).toISOString(),
    };
    const parsed = federationPresenceUserSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

/** Builds a bounded, privacy-filtered presence payload for an authenticated peer. */
export async function getFederationPresenceExport(): Promise<FederationPresence> {
    const presence = await onlinePresence();
    if (presence.size === 0) return { users: [] };
    const users: ExportUser[] = await prisma.user.findMany({
        where: {
            id: { in: [...presence.keys()] },
            settings: {
                is: {
                    shareOnlinePresence: true,
                },
            },
        },
        select: {
            id: true,
            username: true,
            displayName: true,
            settings: {
                select: {
                    shareOnlinePresence: true,
                    shareListeningStatus: true,
                },
            },
            playbackStates: {
                orderBy: { updatedAt: "desc" },
                take: 1,
                select: {
                    playbackType: true,
                    isPlaying: true,
                    updatedAt: true,
                    currentIndex: true,
                    queue: true,
                },
            },
        },
        orderBy: { username: "asc" },
        take: MAX_EXPORT_USERS,
    });
    const exported = users.flatMap((user) => {
        const heartbeat = presence.get(user.id);
        if (heartbeat === undefined) return [];
        const value = exportUser(user, heartbeat);
        return value ? [value] : [];
    });
    return { users: exported.slice(0, MAX_EXPORT_USERS) };
}

/** Stores one validated peer snapshot with a caller-owned expiry policy. */
export async function storeFederationPeerPresenceSnapshot(
    snapshot: FederationPeerPresenceSnapshot,
    ttlSeconds: number,
): Promise<void> {
    const parsed = federationPeerPresenceSnapshotSchema.parse(snapshot);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
        throw new RangeError("Federation presence TTL must be positive");
    }
    await redisClient.set(
        federationPeerPresenceKey(parsed.peerId),
        JSON.stringify(parsed),
        { expiration: { type: "EX", value: ttlSeconds } },
    );
}

/** Reads and validates all bounded, unexpired peer presence snapshots. */
export async function readFederationPeerPresenceSnapshots(): Promise<
    FederationPeerPresenceSnapshot[]
> {
    const keys = await scanKeys(PEER_PRESENCE_KEY_PREFIX, MAX_PEER_SNAPSHOTS);
    if (keys.length === 0) return [];
    const values = await redisClient.mGet(keys);
    const snapshots: FederationPeerPresenceSnapshot[] = [];
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (typeof value !== "string") continue;
        try {
            const parsed = federationPeerPresenceSnapshotSchema.safeParse(
                JSON.parse(value) as unknown,
            );
            const peerId = keys[index].slice(PEER_PRESENCE_KEY_PREFIX.length);
            if (parsed.success && parsed.data.peerId === peerId) {
                snapshots.push(parsed.data);
            }
        } catch (_error: unknown) {
            continue;
        }
    }
    return snapshots.sort((a, b) => a.peerName.localeCompare(b.peerName));
}
