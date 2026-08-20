import { randomUUID } from "crypto";
import { config } from "../config";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import { GroupError } from "./listenTogetherManager";

const log = logger.child("ListenTogetherMutationLock");
const mutationLockNodeId = randomUUID();
const localMutationTails = new Map<string, Promise<void>>();
let mutationLockRedisClient = config.listenTogether.mutationLockEnabled
    ? createIORedisClient("listen-together-mutation-locks")
    : null;

export interface GroupMutationLockHooks {
    beforeOperation?: () => Promise<void>;
    afterOperation?: () => Promise<void>;
    onAcquireFailure?: () => void;
}

interface RedisLock {
    key: string;
    token: string;
}

async function acquireRedisLock(
    groupId: string,
    operationName: string,
    onAcquireFailure?: () => void,
): Promise<RedisLock> {
    const key = `${config.listenTogether.mutationLockPrefix}:${groupId}`;
    const token = `${mutationLockNodeId}:${Date.now()}:${Math.random()}`;
    const ttlSeconds = Math.max(
        1,
        Math.ceil(config.listenTogether.mutationLockTtlMs / 1000),
    );

    try {
        const acquired = await mutationLockRedisClient!.set(
            key,
            token,
            "EX",
            ttlSeconds,
            "NX",
        );
        if (acquired !== "OK") {
            throw new GroupError(
                "CONFLICT",
                "Another group update is in progress. Please retry.",
            );
        }
        return { key, token };
    } catch (error) {
        if (error instanceof GroupError) throw error;
        log.error(
            `[ListenTogether/MutationLock] Failed to acquire lock for ${operationName} (${groupId})`,
            error,
        );
        onAcquireFailure?.();
        throw new GroupError(
            "CONFLICT",
            "Group coordination temporarily unavailable. Please retry.",
        );
    }
}

async function releaseRedisLock(
    lock: RedisLock,
    groupId: string,
    operationName: string,
): Promise<void> {
    try {
        await mutationLockRedisClient!.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            lock.key,
            lock.token,
        );
    } catch (error) {
        log.warn(
            `[ListenTogether/MutationLock] Failed to release lock for ${operationName} (${groupId})`,
            error,
        );
    }
}

async function runLockedOperation<T>(
    groupId: string,
    operationName: string,
    operation: () => Promise<T>,
    hooks: GroupMutationLockHooks,
): Promise<T> {
    if (!mutationLockRedisClient) {
        try {
            return await operation();
        } finally {
            await hooks.afterOperation?.();
        }
    }

    const lock = await acquireRedisLock(
        groupId,
        operationName,
        hooks.onAcquireFailure,
    );
    try {
        await hooks.beforeOperation?.();
        return await operation();
    } finally {
        await hooks.afterOperation?.();
        await releaseRedisLock(lock, groupId, operationName);
    }
}

/** Serialize same-group mutations locally and across backend replicas. */
export async function withGroupMutationLock<T>(
    groupId: string,
    operationName: string,
    operation: () => Promise<T>,
    hooks: GroupMutationLockHooks = {},
): Promise<T> {
    const previous = localMutationTails.get(groupId) ?? Promise.resolve();
    let releaseLocalLock: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
        releaseLocalLock = resolve;
    });
    const tail = previous.then(() => current);
    localMutationTails.set(groupId, tail);
    await previous;

    try {
        return await runLockedOperation(
            groupId,
            operationName,
            operation,
            hooks,
        );
    } finally {
        releaseLocalLock();
        if (localMutationTails.get(groupId) === tail) {
            localMutationTails.delete(groupId);
        }
    }
}

/** Release the Redis client owned by the shared mutation lock. */
export function shutdownGroupMutationLock(): void {
    mutationLockRedisClient?.disconnect();
    mutationLockRedisClient = null;
    localMutationTails.clear();
}
