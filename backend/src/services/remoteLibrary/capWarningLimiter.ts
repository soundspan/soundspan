import type { RemoteLibraryProvider } from "./types";

const WARNING_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;

/** Bounds and rate-limits cap warnings by user and provider. */
export class RemoteLibraryCapWarningLimiter {
    private readonly warnedAt = new Map<string, number>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    ) {}

    /** Returns true when the caller may emit the warning. */
    shouldWarn(userId: string, provider: RemoteLibraryProvider): boolean {
        const key = `${userId}:${provider}`;
        const now = this.now();
        const previous = this.warnedAt.get(key);
        if (previous !== undefined && now - previous < WARNING_INTERVAL_MS) {
            return false;
        }
        this.warnedAt.delete(key);
        this.warnedAt.set(key, now);
        this.evictOldest();
        return true;
    }

    private evictOldest(): void {
        if (this.warnedAt.size <= this.maxEntries) return;
        const oldest = this.warnedAt.keys().next().value;
        if (oldest !== undefined) this.warnedAt.delete(oldest);
    }
}
