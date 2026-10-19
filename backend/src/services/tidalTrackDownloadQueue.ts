import { requestCoalescedLibraryScan } from "./coalescedLibraryScan";
import { tidalService } from "./tidal";
import { logger, type Logger } from "../utils/logger";

const MAX_DRAIN_ITERATIONS = 1024;
const MAX_CONFIGURED_PENDING = MAX_DRAIN_ITERATIONS - 1;

interface TidalTrackDownloadItem {
    tidalTrackId: number;
    userId: string;
}

interface TidalTrackDownloadResult {
    relative_path: string;
}

interface TidalTrackDownloadQueueDependencies {
    downloadTrack: (tidalTrackId: number) => Promise<TidalTrackDownloadResult>;
    requestScan: (
        userId: string,
        triggerSource: "tidal-download",
    ) => Promise<void>;
    maxPending: number;
    log: Pick<Logger, "info" | "warn">;
}

/** Raised when a new track cannot enter the bounded pending queue. */
export class TidalTrackDownloadQueueFullError extends Error {
    constructor() {
        super("TIDAL track download queue is full");
        this.name = "TidalTrackDownloadQueueFullError";
    }
}

/** In-process admission and test-observation surface for single-track work. */
export interface TidalTrackDownloadQueue {
    /** Add a track unless the same TIDAL id is pending or running. */
    enqueue(item: TidalTrackDownloadItem): "queued" | "already-queued";
    /** Resolve when all work accepted before or during this drain is complete. */
    onIdle(): Promise<void>;
}

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause !== "object" || cause === null) return "Unknown error";
    const message = (cause as { message?: unknown }).message;
    return typeof message === "string" ? message : "Unknown error";
}

function errorHttpStatus(cause: unknown): number | undefined {
    if (typeof cause !== "object" || cause === null) return undefined;
    const response = (cause as { response?: unknown }).response;
    if (typeof response !== "object" || response === null) return undefined;
    const status = (response as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
}

class InProcessTidalTrackDownloadQueue implements TidalTrackDownloadQueue {
    private readonly pending: TidalTrackDownloadItem[] = [];
    private readonly trackedIds = new Set<number>();
    private drainTask: Promise<void> | null = null;
    private idlePromise: Promise<void> | null = null;
    private resolveIdle: (() => void) | null = null;

    constructor(
        private readonly dependencies: TidalTrackDownloadQueueDependencies,
    ) {}

    enqueue(item: TidalTrackDownloadItem): "queued" | "already-queued" {
        if (this.trackedIds.has(item.tidalTrackId)) return "already-queued";
        if (this.pending.length >= this.dependencies.maxPending) {
            throw new TidalTrackDownloadQueueFullError();
        }
        this.pending.push(item);
        this.trackedIds.add(item.tidalTrackId);
        this.startDrain();
        return "queued";
    }

    onIdle(): Promise<void> {
        if (this.drainTask === null && this.pending.length === 0) {
            return Promise.resolve();
        }
        if (this.idlePromise === null) {
            this.idlePromise = new Promise((resolve) => {
                this.resolveIdle = resolve;
            });
        }
        return this.idlePromise;
    }

    private startDrain(): void {
        if (this.drainTask !== null || this.pending.length === 0) return;
        this.drainTask = this.runOwnedDrain();
    }

    private async runOwnedDrain(): Promise<void> {
        try {
            await this.drainItems();
        } catch (error) {
            this.dependencies.log.warn("TIDAL track queue drain failed", {
                errorMessage: errorMessage(error),
            });
        } finally {
            this.drainTask = null;
            this.finishOrContinue();
        }
    }

    private async drainItems(): Promise<void> {
        for (
            let iteration = 0;
            iteration < MAX_DRAIN_ITERATIONS;
            iteration += 1
        ) {
            const item = this.pending.shift();
            if (item === undefined) return;
            try {
                await this.processItem(item);
            } finally {
                this.trackedIds.delete(item.tidalTrackId);
            }
        }
    }

    private async processItem(item: TidalTrackDownloadItem): Promise<void> {
        let result: TidalTrackDownloadResult;
        try {
            result = await this.dependencies.downloadTrack(item.tidalTrackId);
        } catch (error) {
            this.logDownloadFailure(item.tidalTrackId, error);
            return;
        }
        this.dependencies.log.info("TIDAL track download finished", {
            tidalTrackId: item.tidalTrackId,
            relative_path: result.relative_path,
        });
        await this.requestScan(item);
    }

    private async requestScan(item: TidalTrackDownloadItem): Promise<void> {
        try {
            await this.dependencies.requestScan(item.userId, "tidal-download");
        } catch (error) {
            this.dependencies.log.warn(
                "Failed to request library scan after TIDAL track download",
                {
                    tidalTrackId: item.tidalTrackId,
                    errorMessage: errorMessage(error),
                },
            );
        }
    }

    private logDownloadFailure(tidalTrackId: number, error: unknown): void {
        const httpStatus = errorHttpStatus(error);
        this.dependencies.log.warn("TIDAL track download failed", {
            tidalTrackId,
            ...(httpStatus === undefined ? {} : { httpStatus }),
            errorMessage: errorMessage(error),
        });
    }

    private finishOrContinue(): void {
        if (this.pending.length > 0) {
            setImmediate(() => this.startDrain());
            return;
        }
        const resolve = this.resolveIdle;
        this.idlePromise = null;
        this.resolveIdle = null;
        resolve?.();
    }
}

/**
 * Create a bounded single-track queue with explicit runtime dependencies.
 * Throws `RangeError` when `maxPending` is outside the supported bound.
 */
export function createTidalTrackDownloadQueue(
    dependencies: TidalTrackDownloadQueueDependencies,
): TidalTrackDownloadQueue {
    if (
        !Number.isInteger(dependencies.maxPending) ||
        dependencies.maxPending < 1 ||
        dependencies.maxPending > MAX_CONFIGURED_PENDING
    ) {
        throw new RangeError(
            `maxPending must be an integer between 1 and ${MAX_CONFIGURED_PENDING}`,
        );
    }
    return new InProcessTidalTrackDownloadQueue(dependencies);
}

// This queue is per API process, so HA replicas can repeat the same track.
// The sidecar reuses a matching embedded TIDAL id and replaces that track's file;
// occupied paths tagged with another id receive identity-suffixed candidates.
const tidalTrackDownloadQueue = createTidalTrackDownloadQueue({
    downloadTrack: (tidalTrackId) => tidalService.downloadTrack(tidalTrackId),
    requestScan: requestCoalescedLibraryScan,
    maxPending: 25,
    log: logger.child("TidalTrackDownloadQueue"),
});

export default tidalTrackDownloadQueue;
