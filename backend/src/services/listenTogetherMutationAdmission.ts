import { config } from "../config";
import { logger } from "../utils/logger";
import { withListenTogetherDeadline } from "./listenTogetherDeadline";
import { GroupError } from "./listenTogetherGroupError";

const log = logger.child("ListenTogetherMutationAdmission");
const MAX_DRAIN_PROGRESS_CHECKS = 10_000;
const MUTATION_DRAIN_DEADLINE_MS =
    config.listenTogether.mutationDrainDeadlineMs ?? 10_000;

let acceptingMutations = true;
let admittedMutations = 0;
const progressWaiters = new Set<() => void>();

function notifyDrainProgress(): void {
    for (const resolve of progressWaiters) resolve();
    progressWaiters.clear();
}

function waitForDrainProgress(): Promise<void> {
    return new Promise<void>((resolve) => progressWaiters.add(resolve));
}

async function runAdmittedMutation<T>(operation: () => Promise<T>): Promise<T> {
    admittedMutations += 1;
    try {
        return await operation();
    } finally {
        admittedMutations -= 1;
        notifyDrainProgress();
    }
}

/** Outcome and remaining budget from the one monotonic shutdown drain deadline. */
export interface ListenTogetherDrainResult {
    drained: boolean;
    deadlineAtMs: number;
    remainingMs: number;
}

function drainResult(
    drained: boolean,
    deadlineAtMs: number,
): ListenTogetherDrainResult {
    return {
        drained,
        deadlineAtMs,
        remainingMs: Math.max(0, deadlineAtMs - Date.now()),
    };
}

function warnDrainDeadlineExpired(
    deadlineAtMs: number,
): ListenTogetherDrainResult {
    log.warn("Mutation drain deadline expired", {
        admittedMutations,
        deadlineMs: MUTATION_DRAIN_DEADLINE_MS,
    });
    return drainResult(false, deadlineAtMs);
}

/** Admit one complete Listen Together mutation before shutdown starts. */
export async function withListenTogetherMutationAdmission<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    if (!acceptingMutations) {
        throw new GroupError(
            "UNAVAILABLE",
            "Listen Together is shutting down. Please retry shortly.",
        );
    }
    return runAdmittedMutation(operation);
}

/** Admit work owned by shutdown after ordinary intake has closed. */
export function withListenTogetherShutdownMutationAdmission<T>(
    operation: () => Promise<T>,
): Promise<T> {
    return runAdmittedMutation(operation);
}

/** Reject new mutations and wait within one total deadline for admitted work. */
export async function stopListenTogetherMutationAdmission(
    deadlineAtMs = Date.now() + MUTATION_DRAIN_DEADLINE_MS,
): Promise<ListenTogetherDrainResult> {
    acceptingMutations = false;
    for (
        let check = 0;
        check < MAX_DRAIN_PROGRESS_CHECKS && admittedMutations > 0;
        check += 1
    ) {
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) return warnDrainDeadlineExpired(deadlineAtMs);
        try {
            await withListenTogetherDeadline(
                waitForDrainProgress(),
                "listen together mutation drain",
                remainingMs,
            );
        } catch {
            return warnDrainDeadlineExpired(deadlineAtMs);
        }
    }
    if (admittedMutations === 0) return drainResult(true, deadlineAtMs);
    log.warn("Mutation drain progress limit reached", { admittedMutations });
    return drainResult(false, deadlineAtMs);
}

/** Re-open mutation admission when a fresh API socket lifecycle starts. */
export function resetListenTogetherMutationAdmission(): void {
    acceptingMutations = true;
}
