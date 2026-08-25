import type { EnrichmentState } from "../services/enrichmentState";

type EnrichmentCompletionState = Pick<
    EnrichmentState,
    | "status"
    | "completionNotificationSent"
    | "coreCacheCleared"
    | "fullCacheCleared"
    | "pendingMoodBucketBackfill"
    | "moodBucketBackfillInProgress"
>;

/** Return true when persisted completion markers make a progress snapshot redundant. */
export function shouldSkipEnrichmentSnapshot(
    state: Partial<EnrichmentCompletionState> | null,
    bypassIdle = false,
): boolean {
    return (
        !bypassIdle &&
        state?.status === "idle" &&
        state.completionNotificationSent === true &&
        state.coreCacheCleared === true &&
        state.fullCacheCleared === true &&
        state.pendingMoodBucketBackfill !== true &&
        state.moodBucketBackfillInProgress !== true
    );
}

/** Track bounded exponential delay between enrichment cycles that find no work. */
export class EnrichmentIdleBackoff {
    private idleCycles = 0;
    private nextCycleAtMs = 0;

    constructor(
        private readonly baseDelayMs: number,
        private readonly maximumDelayMs: number,
    ) {
        if (baseDelayMs <= 0 || maximumDelayMs < baseDelayMs) {
            throw new RangeError("Invalid enrichment idle backoff bounds");
        }
    }

    /** Return the current delay after applying the configured cap. */
    getDelayMs(): number {
        return Math.min(
            this.maximumDelayMs,
            this.baseDelayMs * 2 ** this.idleCycles,
        );
    }

    /** Return whether the next scheduled cycle may run. */
    isDue(nowMs: number): boolean {
        return nowMs >= this.nextCycleAtMs;
    }

    /** Extend the next-cycle delay after a cycle found no work. */
    recordIdle(nowMs: number): void {
        this.idleCycles = Math.min(this.idleCycles + 1, 31);
        this.nextCycleAtMs = nowMs + this.getDelayMs();
    }

    /** Restore the base delay after a cycle found work. */
    recordWork(nowMs: number): void {
        this.idleCycles = 0;
        this.nextCycleAtMs = nowMs + this.baseDelayMs;
    }

    /** Record whether a completed scheduled cycle found work. */
    recordCycle(processedWork: boolean, nowMs: number): void {
        if (processedWork) this.recordWork(nowMs);
        else this.recordIdle(nowMs);
    }

    /** Make the next cycle immediately eligible after an external work signal. */
    reset(): void {
        this.idleCycles = 0;
        this.nextCycleAtMs = 0;
    }
}

/** Memoize an asynchronous value for a fixed TTL using an injectable clock. */
export class ExpiringMemo<T> {
    private cached: { value: Promise<T>; expiresAtMs: number } | null = null;

    constructor(
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
    ) {
        if (ttlMs <= 0) {
            throw new RangeError("Memo TTL must be positive");
        }
    }

    /** Return a fresh or unexpired value and coalesce concurrent loads. */
    async get(load: () => Promise<T>): Promise<T> {
        const nowMs = this.now();
        if (this.cached && nowMs < this.cached.expiresAtMs) {
            return this.cached.value;
        }

        const value = load();
        this.cached = { value, expiresAtMs: nowMs + this.ttlMs };
        try {
            return await value;
        } catch (error) {
            if (this.cached?.value === value) this.cached = null;
            throw error;
        }
    }

    /** Remove any memoized progress value. */
    invalidate(): void {
        this.cached = null;
    }
}
