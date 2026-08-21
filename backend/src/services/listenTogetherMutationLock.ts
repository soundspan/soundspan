import { randomUUID } from "crypto";
import { config } from "../config";
import { createIORedisClient } from "../utils/ioredis";
import { logger } from "../utils/logger";
import {
    isListenTogetherDeadlineError,
    withListenTogetherDeadline,
} from "./listenTogetherDeadline";
import type { GroupMutationFence } from "./listenTogetherLeaseFencing";
import type { ListenTogetherDrainResult } from "./listenTogetherMutationAdmission";
import { GroupError } from "./listenTogetherGroupError";
import {
    LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
    LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT,
    LISTEN_TOGETHER_RENEW_LEASE_SCRIPT,
    LISTEN_TOGETHER_VALIDATE_LEASE_SCRIPT,
} from "./listenTogetherRedisScripts";

const log = logger.child("ListenTogetherMutationLock");
const mutationLockNodeId = randomUUID();
const localMutationTails = new Map<string, Promise<void>>();
const localFencingTokens = new Map<string, number>();
const mutationLockMode = {
    usesRedisLease: config.listenTogether.mutationLockEnabled,
    usesRedisFencing:
        config.listenTogether.mutationLockEnabled ||
        config.listenTogether.stateStoreEnabled ||
        config.listenTogether.stateSyncEnabled,
} as const;
let mutationLockRedisClient = mutationLockMode.usesRedisFencing
    ? createIORedisClient("listen-together-mutation-locks")
    : null;

export interface GroupMutationLockHooks {
    beforeOperation?: () => Promise<void>;
    afterOperation?: () => Promise<void>;
    onAcquireFailure?: () => void;
    signal?: AbortSignal;
    /** Caller guarantees every late side effect is independently stale-guarded. */
    abandonOperationOnAbort?: boolean;
}

interface RedisLeaseOwner {
    key: string;
    ownerToken: string;
}

interface RedisLock extends RedisLeaseOwner {
    groupId: string;
    fencingToken: number;
    fenced: boolean;
}

interface LeaseRenewal {
    stop(): Promise<void>;
}

async function awaitLockOperation<T>(
    operation: Promise<T>,
    hooks: GroupMutationLockHooks,
): Promise<T> {
    const signal = hooks.signal;
    if (!signal || !hooks.abandonOperationOnAbort) return operation;
    signal.throwIfAborted();
    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        signal.removeEventListener("abort", onAbort);
        void operation.catch(() => undefined);
    }
}

function invokeLockHook(
    hook: (() => Promise<void>) | undefined,
    hooks: GroupMutationLockHooks,
): Promise<void> {
    if (!hook) return Promise.resolve();
    hooks.signal?.throwIfAborted();
    const invocation = Promise.resolve().then(hook);
    return awaitLockOperation(invocation, hooks);
}

function invokeLockedOperation<T>(
    operation: (fence: GroupMutationFence) => Promise<T>,
    fence: GroupMutationFence,
    hooks: GroupMutationLockHooks,
): Promise<T> {
    hooks.signal?.throwIfAborted();
    const invocation = Promise.resolve().then(() => {
        hooks.signal?.throwIfAborted();
        return operation(fence);
    });
    return awaitLockOperation(invocation, hooks);
}

function lockKey(groupId: string): string {
    return `${config.listenTogether.mutationLockPrefix}:${groupId}`;
}

function fencingCounterKey(groupId: string): string {
    return `${config.listenTogether.mutationLockPrefix}:fencing-token:${groupId}`;
}

function mutationFence(lock: RedisLock): GroupMutationFence {
    return {
        fencingToken: lock.fencingToken,
        requiresMembershipFence: true,
        isFenced: () => lock.fenced,
        assertCurrent: () => assertRedisLockCurrent(lock),
    };
}

function nextLocalFence(groupId: string): GroupMutationFence {
    const fencingToken = (localFencingTokens.get(groupId) ?? 0) + 1;
    localFencingTokens.set(groupId, fencingToken);
    return {
        fencingToken,
        requiresMembershipFence: false,
        isFenced: () => false,
        assertCurrent: async () => undefined,
    };
}

function validFencingToken(value: unknown): number | null {
    const fencingToken = Number(value);
    return Number.isSafeInteger(fencingToken) && fencingToken > 0
        ? fencingToken
        : null;
}

async function nextRedisFence(groupId: string): Promise<GroupMutationFence> {
    const fencingToken = validFencingToken(
        await withListenTogetherDeadline(
            mutationLockRedisClient!.incr(fencingCounterKey(groupId)),
            "mutation fencing token allocation",
            config.listenTogether.publicationDeadlineMs,
        ),
    );
    if (fencingToken === null) {
        throw new Error("Redis returned an invalid mutation fencing token");
    }
    return {
        fencingToken,
        requiresMembershipFence: true,
        isFenced: () => false,
        assertCurrent: async () => {
            const allocated = validFencingToken(
                await withListenTogetherDeadline(
                    mutationLockRedisClient!.get(fencingCounterKey(groupId)),
                    "mutation fencing token validation",
                    config.listenTogether.publicationDeadlineMs,
                ),
            );
            if (allocated !== fencingToken) {
                throw fencedConflict();
            }
        },
    };
}

function fencedConflict(): GroupError {
    return new GroupError(
        "CONFLICT",
        "Group coordination lease expired. Please retry.",
    );
}

function redisLeaseWasGranted(acquisition: unknown): boolean {
    return (
        Array.isArray(acquisition) &&
        (acquisition[0] === 1 || acquisition[0] === "1")
    );
}

function consumeAbandonedRedisCommand(command: Promise<unknown>): void {
    void command.then(
        () => undefined,
        () => undefined,
    );
}

function cleanUpLateRedisAcquisition(
    acquisition: Promise<unknown>,
    owner: RedisLeaseOwner,
    groupId: string,
    operationName: string,
): void {
    void acquisition.then(
        (result) => {
            if (!redisLeaseWasGranted(result)) return;
            consumeAbandonedRedisCommand(
                releaseRedisLock(owner, groupId, operationName),
            );
        },
        () => undefined,
    );
}

async function awaitRedisAcquisition(
    acquisition: Promise<unknown>,
    owner: RedisLeaseOwner,
    groupId: string,
    operationName: string,
): Promise<unknown> {
    try {
        return await withListenTogetherDeadline(
            acquisition,
            "mutation lock acquisition",
            config.listenTogether.publicationDeadlineMs,
        );
    } catch (error) {
        if (!isListenTogetherDeadlineError(error)) throw error;
        cleanUpLateRedisAcquisition(acquisition, owner, groupId, operationName);
        throw error;
    }
}

async function acquireRedisLock(
    groupId: string,
    operationName: string,
    onAcquireFailure?: () => void,
): Promise<RedisLock> {
    const key = lockKey(groupId);
    const ownerToken = `${mutationLockNodeId}:${randomUUID()}`;

    try {
        const acquisitionCommand = mutationLockRedisClient!.eval(
            LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
            2,
            key,
            fencingCounterKey(groupId),
            ownerToken,
            `${config.listenTogether.mutationLockTtlMs}`,
        );
        const acquisition = await awaitRedisAcquisition(
            acquisitionCommand,
            { key, ownerToken },
            groupId,
            operationName,
        );
        if (!Array.isArray(acquisition) || Number(acquisition[0]) !== 1) {
            throw new GroupError(
                "CONFLICT",
                "Another group update is in progress. Please retry.",
            );
        }
        const fencingToken = validFencingToken(acquisition[1]);
        if (fencingToken === null) {
            throw new Error("Redis returned an invalid mutation fencing token");
        }
        return { groupId, key, ownerToken, fencingToken, fenced: false };
    } catch (error) {
        if (error instanceof GroupError) {
            onAcquireFailure?.();
            throw error;
        }
        log.error("Failed to acquire group mutation lock", {
            groupId,
            operationName,
            error,
        });
        onAcquireFailure?.();
        throw new GroupError(
            "CONFLICT",
            "Group coordination temporarily unavailable. Please retry.",
        );
    }
}

async function assertRedisLockCurrent(lock: RedisLock): Promise<void> {
    if (lock.fenced) throw fencedConflict();
    const result = await withListenTogetherDeadline(
        mutationLockRedisClient!.eval(
            LISTEN_TOGETHER_VALIDATE_LEASE_SCRIPT,
            2,
            lock.key,
            fencingCounterKey(lock.groupId),
            lock.ownerToken,
            `${lock.fencingToken}`,
        ),
        "mutation lease validation",
        config.listenTogether.publicationDeadlineMs,
    );
    if (result !== 1) {
        lock.fenced = true;
        throw fencedConflict();
    }
}

async function renewRedisLock(
    lock: RedisLock,
    groupId: string,
    operationName: string,
): Promise<void> {
    try {
        const renewal = mutationLockRedisClient!.eval(
            LISTEN_TOGETHER_RENEW_LEASE_SCRIPT,
            1,
            lock.key,
            lock.ownerToken,
            `${config.listenTogether.mutationLockTtlMs}`,
        );
        let renewed: unknown;
        try {
            renewed = await withListenTogetherDeadline(
                renewal,
                "mutation lock renewal",
                config.listenTogether.publicationDeadlineMs,
            );
        } catch (error) {
            if (!isListenTogetherDeadlineError(error)) throw error;
            consumeAbandonedRedisCommand(renewal);
            throw error;
        }
        if (renewed === 1) return;
    } catch (error) {
        lock.fenced = true;
        log.warn("Failed to renew group mutation lock", {
            groupId,
            operationName,
            error,
        });
        return;
    }
    lock.fenced = true;
}

function startLeaseRenewal(
    lock: RedisLock,
    groupId: string,
    operationName: string,
): LeaseRenewal {
    let renewal: Promise<void> | null = null;
    const timer = setInterval(() => {
        if (renewal || lock.fenced) return;
        renewal = renewRedisLock(lock, groupId, operationName).finally(() => {
            renewal = null;
            if (lock.fenced) clearInterval(timer);
        });
    }, config.listenTogether.mutationLockRenewIntervalMs);
    if (typeof timer.unref === "function") timer.unref();

    return {
        async stop(): Promise<void> {
            clearInterval(timer);
            if (renewal) await renewal;
        },
    };
}

async function releaseRedisLock(
    lock: RedisLeaseOwner,
    groupId: string,
    operationName: string,
): Promise<void> {
    try {
        await withListenTogetherDeadline(
            mutationLockRedisClient!.eval(
                LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT,
                1,
                lock.key,
                lock.ownerToken,
            ),
            "mutation lock release",
            config.listenTogether.publicationDeadlineMs,
        );
    } catch (error) {
        log.warn("Failed to release group mutation lock", {
            groupId,
            operationName,
            error,
        });
    }
}

async function acquireRedisLockForOperation(
    groupId: string,
    operationName: string,
    hooks: GroupMutationLockHooks,
): Promise<RedisLock> {
    const acquisition = acquireRedisLock(
        groupId,
        operationName,
        hooks.onAcquireFailure,
    );
    if (!hooks.signal || !hooks.abandonOperationOnAbort) return acquisition;
    try {
        return await awaitLockOperation(acquisition, hooks);
    } catch (error) {
        if (hooks.signal.aborted) {
            // A late successful SET still owns a lease. Release it by its
            // owner token, but never enter the abandoned mutation.
            void acquisition.then(
                (lock) => releaseRedisLock(lock, groupId, operationName),
                () => undefined,
            );
        }
        throw error;
    }
}

async function runLocalOperation<T>(
    groupId: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    hooks: GroupMutationLockHooks,
): Promise<T> {
    let fence: GroupMutationFence;
    try {
        fence = mutationLockMode.usesRedisFencing
            ? await nextRedisFence(groupId)
            : nextLocalFence(groupId);
    } catch (error) {
        hooks.onAcquireFailure?.();
        throw error;
    }
    try {
        hooks.signal?.throwIfAborted();
        await invokeLockHook(hooks.beforeOperation, hooks);
        return await invokeLockedOperation(operation, fence, hooks);
    } finally {
        await invokeLockHook(hooks.afterOperation, hooks);
    }
}

async function runRedisOperation<T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    hooks: GroupMutationLockHooks,
): Promise<T> {
    const lock = await acquireRedisLockForOperation(
        groupId,
        operationName,
        hooks,
    );
    let leaseRenewal: LeaseRenewal | null = null;
    try {
        hooks.signal?.throwIfAborted();
        leaseRenewal = startLeaseRenewal(lock, groupId, operationName);
        let result: T;
        try {
            await invokeLockHook(hooks.beforeOperation, hooks);
            result = await invokeLockedOperation(
                operation,
                mutationFence(lock),
                hooks,
            );
        } finally {
            await invokeLockHook(hooks.afterOperation, hooks);
        }
        await leaseRenewal.stop();
        await assertRedisLockCurrent(lock);
        if (lock.fenced) throw fencedConflict();
        return result;
    } finally {
        await leaseRenewal?.stop();
        await releaseRedisLock(lock, groupId, operationName);
    }
}

/** Wait within the shared shutdown deadline for every local mutation boundary. */
export async function drainListenTogetherMutationLocks(
    deadlineAtMs: number,
): Promise<ListenTogetherDrainResult> {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        return { drained: false, deadlineAtMs, remainingMs: 0 };
    }
    const tails = Array.from(localMutationTails.values());
    try {
        if (tails.length > 0) {
            await withListenTogetherDeadline(
                Promise.allSettled(tails),
                "listen together mutation lock drain",
                remainingMs,
            );
        }
        return {
            drained: true,
            deadlineAtMs,
            remainingMs: Math.max(0, deadlineAtMs - Date.now()),
        };
    } catch {
        return { drained: false, deadlineAtMs, remainingMs: 0 };
    }
}

/** Release fully local fencing state after a definitive group end. */
export function releaseLocalGroupMutationState(groupId: string): void {
    if (!mutationLockMode.usesRedisFencing) localFencingTokens.delete(groupId);
}

async function enqueueLocalGroupBoundary<T>(
    groupId: string,
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
    void tail.finally(() => {
        if (localMutationTails.get(groupId) === tail) {
            localMutationTails.delete(groupId);
        }
    });
    try {
        await awaitLockOperation(previous, hooks);
        return await operation();
    } finally {
        releaseLocalLock();
    }
}

/** Serialize a cluster consumer locally without acquiring or allocating Redis state. */
export function withLocalGroupMutationBoundary<T>(
    groupId: string,
    operation: () => Promise<T>,
): Promise<T> {
    return enqueueLocalGroupBoundary(groupId, operation);
}

async function runLockedOperation<T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    hooks: GroupMutationLockHooks,
): Promise<T> {
    if (!mutationLockMode.usesRedisLease) {
        return runLocalOperation(groupId, operation, hooks);
    }
    return runRedisOperation(groupId, operationName, operation, hooks);
}

/** Serialize same-group mutations locally and across backend replicas. */
export async function withGroupMutationLock<T>(
    groupId: string,
    operationName: string,
    operation: (fence: GroupMutationFence) => Promise<T>,
    hooks: GroupMutationLockHooks = {},
): Promise<T> {
    return enqueueLocalGroupBoundary(
        groupId,
        async () => {
            hooks.signal?.throwIfAborted();
            return runLockedOperation(groupId, operationName, operation, hooks);
        },
        hooks,
    );
}

/** Release the Redis client owned by the shared mutation lock. */
export function shutdownGroupMutationLock(): void {
    mutationLockRedisClient?.disconnect();
    mutationLockRedisClient = null;
    localMutationTails.clear();
    localFencingTokens.clear();
}
