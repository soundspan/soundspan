/**
 * The Listen Together ready-report machine (GH #787). When the server says
 * "buffer this track and report ready", one runner instance owns the poll
 * timer, the engine load listener, and the awaited target, reporting
 * readiness on the matching load event with bounded polling as a fallback.
 * Decision math lives in listenTogetherReadyReport; side effects arrive
 * through injected ports so the machine is testable without React or a
 * socket.
 */

import { resolveListenTogetherReadyReportRecoveryAction } from "@/lib/listenTogetherContextState";
import {
    evaluateReadyReport,
    type ReadyReportSnapshot,
} from "@/lib/listenTogetherReadyReport";

export const LT_READY_REPORT_POLL_INTERVAL_MS = 100;
export const LT_READY_REPORT_DELAY_MS = 150;
export const LT_READY_REPORT_RETRY_DELAY_MS = 180;
export const LT_READY_REPORT_MAX_WAIT_MS = 7_500;

export interface ReadyReportTarget {
    currentIndex: number;
    trackId: string | null;
}

export interface ReadyReportRunnerPorts {
    /** Attach/detach a listener on the playback engine's load event. */
    engineOn(listener: () => void): void;
    engineOff(listener: () => void): void;
    /** Snapshot of local and server track state for one decision tick. */
    readSnapshot(
        target: ReadyReportTarget,
        elapsedMs: number,
    ): ReadyReportSnapshot;
    reportReady(): Promise<void>;
    /** Log and schedule a group resync; invoked at most once per begin(). */
    recover(reason: string, details: Record<string, unknown>): void;
    /** Clock override for tests; defaults to Date.now. */
    now?(): number;
}

export class ListenTogetherReadyReportRunner {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private loadListener: (() => void) | null = null;
    private target: ReadyReportTarget | null = null;

    constructor(private readonly ports: ReadyReportRunnerPorts) {}

    private now(): number {
        return this.ports.now ? this.ports.now() : Date.now();
    }

    /** Drop the engine load listener and forget the awaited target. */
    detachLoadListener(): void {
        if (this.loadListener) {
            this.ports.engineOff(this.loadListener);
            this.loadListener = null;
        }
        this.target = null;
    }

    /**
     * Drop the load listener when the session moved to a different track;
     * the poll timer keeps running against the original waiting target.
     */
    detachLoadListenerIfObsolete(
        nextTrackIndex: number,
        nextTrackId: string | null,
    ): void {
        const target = this.target;
        const trackChanged = Boolean(
            target &&
            (target.currentIndex !== nextTrackIndex ||
                (target.trackId &&
                    nextTrackId &&
                    target.trackId !== nextTrackId)),
        );
        if (trackChanged) {
            this.detachLoadListener();
        }
    }

    /** Cancel the poll/delay timer without touching the load listener. */
    clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Start waiting on a server waiting event. Cancels any previous wait. */
    begin(target: ReadyReportTarget): void {
        this.detachLoadListener();
        this.clearTimer();

        const startedAt = this.now();
        let terminalRetryAttempted = false;
        let recoveryTriggered = false;

        const recoverOnce = (
            reason: string,
            details: Record<string, unknown>,
        ) => {
            if (recoveryTriggered) return;
            recoveryTriggered = true;
            this.ports.recover(reason, details);
        };

        const tryReportReady = () => {
            const snapshot = this.ports.readSnapshot(
                target,
                this.now() - startedAt,
            );
            const evaluation = evaluateReadyReport(snapshot);

            if (evaluation.decision === "report") {
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.detachLoadListener();
                    this.ports.reportReady().catch((error) => {
                        const elapsedMs = this.now() - startedAt;
                        const recoveryAction =
                            resolveListenTogetherReadyReportRecoveryAction({
                                elapsedMs,
                                maxWaitMs: snapshot.maxWaitMs,
                                terminalRetryAttempted,
                            });
                        if (
                            recoveryAction === "retry" ||
                            recoveryAction === "terminal-retry"
                        ) {
                            if (recoveryAction === "terminal-retry") {
                                terminalRetryAttempted = true;
                            }
                            this.timer = setTimeout(
                                tryReportReady,
                                LT_READY_REPORT_RETRY_DELAY_MS,
                            );
                            return;
                        }
                        recoverOnce(
                            "[ListenTogether] reportReady failed after terminal retry window",
                            {
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                                elapsedMs,
                                expectedTrackId: snapshot.expectedTrackId,
                                queuedTrackId: snapshot.queuedTrackId,
                                activeTrackId: snapshot.activeTrackId,
                                terminalRetryAttempted,
                            },
                        );
                    });
                }, LT_READY_REPORT_DELAY_MS);
                return;
            }

            if (evaluation.decision === "recover") {
                this.clearTimer();
                this.detachLoadListener();
                recoverOnce(
                    "[ListenTogether] ready report timed out before local media was ready",
                    {
                        expectedTrackId: snapshot.expectedTrackId,
                        queuedTrackId: snapshot.queuedTrackId,
                        activeTrackId: snapshot.activeTrackId,
                        loadedTrackId: snapshot.loadedTrackId,
                        mediaReady: evaluation.mediaReady,
                    },
                );
                return;
            }

            this.timer = setTimeout(
                tryReportReady,
                LT_READY_REPORT_POLL_INTERVAL_MS,
            );
        };

        const onTargetTrackLoaded = () => {
            this.detachLoadListener();
            this.clearTimer();
            void this.ports.reportReady().catch(() => {
                this.timer = setTimeout(
                    tryReportReady,
                    LT_READY_REPORT_RETRY_DELAY_MS,
                );
            });
        };

        this.target = target;
        this.loadListener = onTargetTrackLoaded;
        this.ports.engineOn(onTargetTrackLoaded);
        tryReportReady();
    }
}
