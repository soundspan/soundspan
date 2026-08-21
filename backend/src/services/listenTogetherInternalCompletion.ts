import {
    isListenTogetherDeadlineError,
    listenTogetherRetryDelayMs,
    withListenTogetherDeadline,
} from "./listenTogetherDeadline";

const READY_GATE_COMPLETION_MAX_ATTEMPTS = 3;
const READY_GATE_RETRY_BASE_DELAY_MS = 20;
const READY_GATE_RETRY_MAX_DELAY_MS = 500;
const READY_GATE_TOTAL_DEADLINE_MS = 5_000;

interface ReadyGateAttemptState {
    attempts: number;
    startedAtMs: number;
}

function isTransientConflict(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "CONFLICT" &&
        (!("retryable" in error) || error.retryable !== false)
    );
}

function completionKey(
    groupId: string,
    data: { currentIndex: number; stateVersion: number },
): string {
    return `${groupId}:${data.currentIndex}:${data.stateVersion}`;
}

/** Own the total retry budget for ready-gate completion across timer arms. */
export class ReadyGateCompletionSupervisor {
    private readonly attempts = new Map<string, ReadyGateAttemptState>();
    private readonly activeAttempts = new Map<string, AbortController>();
    private stopped = false;

    constructor(
        private readonly now: () => number = Date.now,
        private readonly random: () => number = Math.random,
    ) {}

    reset(): void {
        this.abortActiveAttempts();
        this.stopped = false;
        this.attempts.clear();
    }

    shutdown(): void {
        this.stopped = true;
        this.abortActiveAttempts();
        this.attempts.clear();
    }

    async run(
        groupId: string,
        data: { currentIndex: number; stateVersion: number },
        complete: (signal: AbortSignal) => Promise<boolean>,
        rearm: (delayMs: number) => void,
    ): Promise<"completed" | "obsolete" | "rearmed" | "exhausted"> {
        if (this.stopped) return "exhausted";
        const key = completionKey(groupId, data);
        const state = this.attempts.get(key) ?? {
            attempts: 0,
            startedAtMs: this.now(),
        };
        if (!this.withinBudget(state)) {
            this.attempts.delete(key);
            return "exhausted";
        }
        state.attempts += 1;
        this.attempts.set(key, state);
        const controller = new AbortController();
        this.activeAttempts.set(key, controller);
        const operation = complete(controller.signal);
        try {
            const completed = await withListenTogetherDeadline(
                operation,
                "listen together ready-gate completion",
                this.remainingBudgetMs(state),
            );
            this.attempts.delete(key);
            return completed ? "completed" : "obsolete";
        } catch (error) {
            if (isListenTogetherDeadlineError(error)) {
                controller.abort(error);
                void operation.catch(() => undefined);
                this.attempts.delete(key);
                return "exhausted";
            }
            if (!isTransientConflict(error)) {
                this.attempts.delete(key);
                throw error;
            }
            if (this.stopped || !this.withinBudget(state)) {
                this.attempts.delete(key);
                return "exhausted";
            }
            rearm(
                listenTogetherRetryDelayMs(
                    state.attempts,
                    READY_GATE_RETRY_BASE_DELAY_MS,
                    READY_GATE_RETRY_MAX_DELAY_MS,
                    this.random,
                ),
            );
            return "rearmed";
        } finally {
            if (this.activeAttempts.get(key) === controller) {
                this.activeAttempts.delete(key);
            }
        }
    }

    private withinBudget(state: ReadyGateAttemptState): boolean {
        return (
            state.attempts < READY_GATE_COMPLETION_MAX_ATTEMPTS &&
            this.now() - state.startedAtMs < READY_GATE_TOTAL_DEADLINE_MS
        );
    }

    private remainingBudgetMs(state: ReadyGateAttemptState): number {
        return Math.max(
            1,
            READY_GATE_TOTAL_DEADLINE_MS - (this.now() - state.startedAtMs),
        );
    }

    private abortActiveAttempts(): void {
        for (const controller of this.activeAttempts.values()) {
            controller.abort(new Error("Ready-gate completion stopped"));
        }
        this.activeAttempts.clear();
    }
}
