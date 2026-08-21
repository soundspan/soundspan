import {
    LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT,
    LISTEN_TOGETHER_CLAIM_FENCE_SCRIPT,
    LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT,
    LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT,
    LISTEN_TOGETHER_RENEW_LEASE_SCRIPT,
    LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT,
    LISTEN_TOGETHER_VALIDATE_LEASE_SCRIPT,
    LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT,
} from "../../listenTogetherRedisScripts";

type StoredValue = {
    value: string;
    expiresAtMs: number | null;
};

export type RedisCommand = {
    clientId: number;
    name: string;
    args: readonly unknown[];
};

type MessageHandler = (channel: string, message: string) => void;
type CommandHook = (command: RedisCommand) => void | Promise<void>;
type PublishHook = (
    channel: string,
    message: string,
    deliver: () => number,
) => number | Promise<number>;

/** Deterministic shared Redis state for lease, Lua, TTL, and pub/sub tests. */
export class DeterministicRedisServer {
    readonly commandLog: RedisCommand[] = [];
    beforeCommand: CommandHook | null = null;
    publishHook: PublishHook | null = null;

    private readonly values = new Map<string, StoredValue>();
    private readonly subscribers = new Map<string, Set<MessageHandler>>();
    private nowMs = 0;
    private nextClientId = 1;

    createClient(): DeterministicRedisClient {
        const client = new DeterministicRedisClient(this, this.nextClientId);
        this.nextClientId += 1;
        return client;
    }

    advanceBy(milliseconds: number): void {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
            throw new RangeError("milliseconds must be non-negative");
        }
        this.nowMs += milliseconds;
    }

    peek(key: string): string | null {
        return this.read(key);
    }

    async run<T>(
        clientId: number,
        name: string,
        args: readonly unknown[],
        operation: () => T | Promise<T>,
    ): Promise<T> {
        const command = { clientId, name, args };
        this.commandLog.push(command);
        await this.beforeCommand?.(command);
        return operation();
    }

    read(key: string): string | null {
        const stored = this.values.get(key);
        if (!stored) return null;
        if (stored.expiresAtMs !== null && stored.expiresAtMs <= this.nowMs) {
            this.values.delete(key);
            return null;
        }
        return stored.value;
    }

    write(key: string, value: string, ttlMs?: number): void {
        this.values.set(key, {
            value,
            expiresAtMs:
                ttlMs === undefined ? null : this.nowMs + Math.max(0, ttlMs),
        });
    }

    delete(key: string): number {
        this.read(key);
        return this.values.delete(key) ? 1 : 0;
    }

    increment(key: string): number {
        const currentRaw = this.read(key);
        const current = Number(currentRaw ?? "0");
        if (!Number.isSafeInteger(current)) {
            throw new Error("ERR value is not an integer or out of range");
        }
        const next = current + 1;
        this.write(key, `${next}`);
        return next;
    }

    expire(key: string, ttlMs: number): number {
        const current = this.read(key);
        if (current === null) return 0;
        this.write(key, current, ttlMs);
        return 1;
    }

    evaluate(script: string, keys: string[], argv: string[]): unknown {
        switch (script) {
            case LISTEN_TOGETHER_ACQUIRE_LEASE_SCRIPT:
                return this.acquireLeaseAndFence(keys, argv);
            case LISTEN_TOGETHER_RENEW_LEASE_SCRIPT:
                return this.renewOwnedLease(keys, argv);
            case LISTEN_TOGETHER_RELEASE_LEASE_SCRIPT:
                return this.releaseOwnedLease(keys, argv);
            case LISTEN_TOGETHER_VALIDATE_LEASE_SCRIPT:
                return this.validateOwnedLease(keys, argv);
            case LISTEN_TOGETHER_SET_SNAPSHOT_SCRIPT:
                return this.setSnapshotIfCurrent(keys, argv);
            case LISTEN_TOGETHER_DELETE_SNAPSHOT_SCRIPT:
                return this.deleteSnapshotIfCurrent(keys, argv);
            case LISTEN_TOGETHER_CLAIM_FENCE_SCRIPT:
                return this.claimFence(keys, argv);
            case LISTEN_TOGETHER_VALIDATE_PUBLICATION_SCRIPT:
                return this.validatePublication(keys, argv);
            default:
                throw new Error("Unsupported deterministic Redis Lua script");
        }
    }

    subscribe(channel: string, handler: MessageHandler): void {
        const handlers = this.subscribers.get(channel) ?? new Set();
        handlers.add(handler);
        this.subscribers.set(channel, handlers);
    }

    unsubscribe(channel: string, handler: MessageHandler): void {
        const handlers = this.subscribers.get(channel);
        handlers?.delete(handler);
        if (handlers?.size === 0) this.subscribers.delete(channel);
    }

    async publish(channel: string, message: string): Promise<number> {
        const deliver = () => {
            const handlers = this.subscribers.get(channel);
            if (!handlers) return 0;
            for (const handler of handlers) handler(channel, message);
            return handlers.size;
        };
        return this.publishHook
            ? this.publishHook(channel, message, deliver)
            : deliver();
    }

    private acquireLeaseAndFence(keys: string[], argv: string[]): number[] {
        const [lockKey, counterKey] = keys;
        const [ownerToken, ttlRaw] = argv;
        const ttlMs = Number(ttlRaw);
        if (
            !lockKey ||
            !counterKey ||
            !ownerToken ||
            !Number.isSafeInteger(ttlMs) ||
            ttlMs < 1
        ) {
            throw new Error("ERR invalid expire time in 'set' command");
        }
        if (this.read(lockKey) !== null) return [0, 0];
        this.write(lockKey, ownerToken, ttlMs);
        const fencingToken = this.increment(counterKey);
        return [1, fencingToken];
    }

    private renewOwnedLease(keys: string[], argv: string[]): number {
        const [key] = keys;
        const [ownerToken, ttlRaw] = argv;
        if (!key || this.read(key) !== ownerToken) return 0;
        return this.expire(key, Number(ttlRaw));
    }

    private releaseOwnedLease(keys: string[], argv: string[]): number {
        const [key] = keys;
        const [ownerToken] = argv;
        if (!key || this.read(key) !== ownerToken) return 0;
        return this.delete(key);
    }

    private validateOwnedLease(keys: string[], argv: string[]): number {
        const [lockKey, counterKey] = keys;
        const [ownerToken, fenceRaw] = argv;
        if (!lockKey || !counterKey) return 0;
        if (this.read(lockKey) !== ownerToken) return 0;
        return Number(this.read(counterKey)) === Number(fenceRaw) ? 1 : 0;
    }

    private tokenIsCurrent(counterKey: string, incomingFence: number): boolean {
        const allocatedRaw = this.read(counterKey);
        if (allocatedRaw === null) return incomingFence === 0;
        return Number(allocatedRaw) === incomingFence;
    }

    private setSnapshotIfCurrent(keys: string[], argv: string[]): number {
        const [snapshotKey, fenceKey, counterKey] = keys;
        const [raw, ttlRaw, versionRaw, serverTimeRaw, fenceRaw] = argv;
        if (!snapshotKey || !fenceKey || !counterKey || raw === undefined) {
            return 0;
        }
        const incomingFence = Number(fenceRaw) || 0;
        const currentFence = Number(this.read(fenceKey)) || 0;
        if (
            !this.tokenIsCurrent(counterKey, incomingFence) ||
            incomingFence < currentFence
        ) {
            return 0;
        }
        const existingRaw = this.read(snapshotKey);
        if (
            existingRaw &&
            !isSnapshotOrderCurrent(
                existingRaw,
                Number(versionRaw) || 0,
                Number(serverTimeRaw) || 0,
            )
        ) {
            return 0;
        }
        const ttlMs = (Number(ttlRaw) || 0) * 1000;
        this.write(snapshotKey, raw, ttlMs);
        this.write(fenceKey, `${incomingFence}`, ttlMs);
        return 1;
    }

    private deleteSnapshotIfCurrent(keys: string[], argv: string[]): number {
        const [snapshotKey, fenceKey, counterKey] = keys;
        const [ttlRaw, fenceRaw] = argv;
        if (!snapshotKey || !fenceKey || !counterKey) return 0;
        const incomingFence = Number(fenceRaw) || 0;
        if (
            !this.tokenIsCurrent(counterKey, incomingFence) ||
            incomingFence < (Number(this.read(fenceKey)) || 0)
        ) {
            return 0;
        }
        this.delete(snapshotKey);
        this.write(fenceKey, `${incomingFence}`, (Number(ttlRaw) || 0) * 1000);
        return 1;
    }

    private claimFence(keys: string[], argv: string[]): number {
        const [fenceKey, counterKey] = keys;
        const [ttlRaw, fenceRaw] = argv;
        if (!fenceKey || !counterKey) return 0;
        const incomingFence = Number(fenceRaw) || 0;
        if (
            !this.tokenIsCurrent(counterKey, incomingFence) ||
            incomingFence < (Number(this.read(fenceKey)) || 0)
        ) {
            return 0;
        }
        this.write(fenceKey, `${incomingFence}`, (Number(ttlRaw) || 0) * 1000);
        return 1;
    }

    private validatePublication(keys: string[], argv: string[]): number {
        const [snapshotKey, fenceKey, counterKey] = keys;
        const [fenceRaw, eventType, versionRaw, serverTimeRaw] = argv;
        if (!snapshotKey || !fenceKey || !counterKey) return 0;
        if (!this.tokenIsCurrent(counterKey, Number(fenceRaw))) return 0;
        const storedFenceRaw = this.read(fenceKey);
        if (
            storedFenceRaw === null ||
            Number(storedFenceRaw) !== Number(fenceRaw)
        ) {
            return 0;
        }
        const existingRaw = this.read(snapshotKey);
        if (eventType === "group-ended") return existingRaw === null ? 1 : 0;
        if (eventType !== "group-snapshot") return 1;
        if (!existingRaw) return 0;
        try {
            const existing = JSON.parse(existingRaw) as {
                playback?: { stateVersion?: unknown; serverTime?: unknown };
            };
            return Number(existing.playback?.stateVersion) ===
                Number(versionRaw) &&
                Number(existing.playback?.serverTime) === Number(serverTimeRaw)
                ? 1
                : 0;
        } catch {
            return 0;
        }
    }
}

function isSnapshotOrderCurrent(
    existingRaw: string,
    incomingVersion: number,
    incomingServerTime: number,
): boolean {
    try {
        const existing = JSON.parse(existingRaw) as {
            playback?: { stateVersion?: unknown; serverTime?: unknown };
        };
        const existingVersion = Number(existing.playback?.stateVersion) || 0;
        const existingServerTime = Number(existing.playback?.serverTime) || 0;
        return (
            incomingVersion > existingVersion ||
            (incomingVersion === existingVersion &&
                incomingServerTime >= existingServerTime)
        );
    } catch {
        return true;
    }
}

/** One independent client connected to a DeterministicRedisServer. */
export class DeterministicRedisClient {
    private readonly messageHandlers = new Set<MessageHandler>();
    private readonly subscribedChannels = new Set<string>();

    constructor(
        private readonly server: DeterministicRedisServer,
        readonly clientId: number,
    ) {}

    async set(
        key: string,
        value: string,
        mode?: string,
        ttl?: number,
        condition?: string,
    ): Promise<"OK" | null> {
        return this.server.run(
            this.clientId,
            "SET",
            [key, value, mode, ttl, condition],
            () => {
                if (condition === "NX" && this.server.read(key) !== null) {
                    return null;
                }
                const ttlMs = mode === "EX" ? Number(ttl) * 1000 : Number(ttl);
                this.server.write(
                    key,
                    value,
                    Number.isFinite(ttlMs) ? ttlMs : undefined,
                );
                return "OK";
            },
        );
    }

    async get(key: string): Promise<string | null> {
        return this.server.run(this.clientId, "GET", [key], () =>
            this.server.read(key),
        );
    }

    async incr(key: string): Promise<number> {
        return this.server.run(this.clientId, "INCR", [key], () =>
            this.server.increment(key),
        );
    }

    async del(key: string): Promise<number> {
        return this.server.run(this.clientId, "DEL", [key], () =>
            this.server.delete(key),
        );
    }

    async eval(
        script: string,
        keyCount: number,
        ...args: string[]
    ): Promise<unknown> {
        return this.server.run(
            this.clientId,
            "EVAL",
            [script, keyCount, ...args],
            () =>
                this.server.evaluate(
                    script,
                    args.slice(0, keyCount),
                    args.slice(keyCount),
                ),
        );
    }

    duplicate(): DeterministicRedisClient {
        return this.server.createClient();
    }

    on(event: string, handler: MessageHandler): this {
        if (event === "message") this.messageHandlers.add(handler);
        return this;
    }

    async subscribe(channel: string): Promise<number> {
        this.subscribedChannels.add(channel);
        for (const handler of this.messageHandlers) {
            this.server.subscribe(channel, handler);
        }
        return this.subscribedChannels.size;
    }

    async unsubscribe(channel: string): Promise<number> {
        for (const handler of this.messageHandlers) {
            this.server.unsubscribe(channel, handler);
        }
        this.subscribedChannels.delete(channel);
        return this.subscribedChannels.size;
    }

    async publish(channel: string, message: string): Promise<number> {
        return this.server.run(
            this.clientId,
            "PUBLISH",
            [channel, message],
            () => this.server.publish(channel, message),
        );
    }

    disconnect(): void {
        for (const channel of this.subscribedChannels) {
            for (const handler of this.messageHandlers) {
                this.server.unsubscribe(channel, handler);
            }
        }
        this.subscribedChannels.clear();
    }
}
