import { logger } from "../utils/logger";
import { createIORedisClient } from "../utils/ioredis";
import type { GroupSnapshot } from "./listenTogetherManager";

const LISTEN_TOGETHER_STATE_STORE_ENABLED =
    process.env.LISTEN_TOGETHER_STATE_STORE_ENABLED !== "false";
const LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX =
    process.env.LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX ||
    "listen-together:state";
const DEFAULT_LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS = 21_600; // 6 hours
const parsedStateStoreTtlSeconds = Number.parseInt(
    process.env.LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS ||
        `${DEFAULT_LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS}`,
    10
);
const LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS =
    Number.isFinite(parsedStateStoreTtlSeconds) && parsedStateStoreTtlSeconds > 0
        ? parsedStateStoreTtlSeconds
        : DEFAULT_LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS;

function isLikelyGroupSnapshot(value: unknown): value is GroupSnapshot {
    if (!value || typeof value !== "object") return false;
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.id !== "string") return false;
    if (!snapshot.playback || typeof snapshot.playback !== "object") return false;
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

const SET_IF_FRESHER_SCRIPT = `
local key = KEYS[1]
local incomingRaw = ARGV[1]
local ttlSeconds = tonumber(ARGV[2])
local incomingStateVersion = tonumber(ARGV[3]) or 0
local incomingServerTime = tonumber(ARGV[4]) or 0

local existingRaw = redis.call('get', key)
if existingRaw then
  local ok, existing = pcall(cjson.decode, existingRaw)
  if ok and existing and existing.playback then
    local existingStateVersion = tonumber(existing.playback.stateVersion) or 0
    local existingServerTime = tonumber(existing.playback.serverTime) or 0
    if incomingStateVersion < existingStateVersion then
      return 0
    end
    if incomingStateVersion == existingStateVersion and incomingServerTime < existingServerTime then
      return 0
    end
  end
end

redis.call('set', key, incomingRaw, 'EX', ttlSeconds)
return 1
`;

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

    async getSnapshot(groupId: string): Promise<GroupSnapshot | null> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) {
            return null;
        }

        try {
            const raw = await this.ensureClient().get(this.key(groupId));
            if (!raw) return null;
            const parsed = JSON.parse(raw) as unknown;
            if (!isLikelyGroupSnapshot(parsed)) {
                logger.warn(
                    `[ListenTogether/StateStore] Ignoring malformed snapshot for group ${groupId}`
                );
                return null;
            }
            if (parsed.id !== groupId) {
                logger.warn(
                    `[ListenTogether/StateStore] Ignoring snapshot with mismatched id for group ${groupId}`
                );
                return null;
            }
            return parsed;
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateStore] Failed to fetch snapshot for group ${groupId}`,
                err
            );
            return null;
        }
    }

    async setSnapshot(groupId: string, snapshot: GroupSnapshot): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) {
            return;
        }

        try {
            const ordering = snapshotOrdering(snapshot);
            await this.ensureClient().eval(
                SET_IF_FRESHER_SCRIPT,
                1,
                this.key(groupId),
                JSON.stringify(snapshot),
                `${LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS}`,
                `${ordering.stateVersion}`,
                `${ordering.serverTime}`
            );
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateStore] Failed to persist snapshot for group ${groupId}`,
                err
            );
        }
    }

    async deleteSnapshot(groupId: string): Promise<void> {
        if (!LISTEN_TOGETHER_STATE_STORE_ENABLED) {
            return;
        }

        try {
            await this.ensureClient().del(this.key(groupId));
        } catch (err) {
            logger.warn(
                `[ListenTogether/StateStore] Failed to delete snapshot for group ${groupId}`,
                err
            );
        }
    }

    stop(): void {
        if (!this.client) return;
        this.client.disconnect();
        this.client = null;
    }
}

export const listenTogetherStateStore = new ListenTogetherStateStore();
