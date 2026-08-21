import { withListenTogetherDeadline } from "./listenTogetherDeadline";
import { drainListenTogetherMutationLocks } from "./listenTogetherMutationLock";
import type { ListenTogetherDrainResult } from "./listenTogetherMutationAdmission";

function failedDrain(deadlineAtMs: number): ListenTogetherDrainResult {
    return { drained: false, deadlineAtMs, remainingMs: 0 };
}

/** Drain local mutation locks and supervised completions under one deadline. */
export async function drainListenTogetherMutationBoundaries(
    deadlineAtMs: number,
    pendingCompletions: Iterable<Promise<unknown>>,
): Promise<ListenTogetherDrainResult> {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) return failedDrain(deadlineAtMs);
    try {
        const [lockDrain] = await withListenTogetherDeadline(
            Promise.all([
                drainListenTogetherMutationLocks(deadlineAtMs),
                Promise.allSettled(Array.from(pendingCompletions)),
            ]),
            "listen together shutdown boundary drain",
            remainingMs,
        );
        if (!lockDrain.drained) return lockDrain;
        return {
            drained: true,
            deadlineAtMs,
            remainingMs: Math.max(0, deadlineAtMs - Date.now()),
        };
    } catch {
        return failedDrain(deadlineAtMs);
    }
}
