import type Bull from "bull";

type QueueProcessorEvent = "active" | "completed" | "failed";

/** Common Bull queue event surface used by worker processor wiring. */
export interface QueueProcessorEventHandlers<JobData = any, Result = any> {
    record?: (
        queueName: string,
        event: QueueProcessorEvent,
        job: Bull.Job<JobData>,
    ) => void;
    recordFailedWithoutJob?: boolean;
    active?: (job: Bull.Job<JobData>) => void;
    completed?: (job: Bull.Job<JobData>, result: Result) => void;
    failed?: (job: Bull.Job<JobData> | undefined, error: Error) => void;
}

/** Register standard processor events and optional queue-specific handlers. */
export function registerQueueProcessorEvents<JobData = any, Result = any>(
    queue: Bull.Queue<JobData>,
    name: string,
    handlers: QueueProcessorEventHandlers<JobData, Result> = {},
): void {
    queue.on("active", (job) => {
        handlers.record?.(name, "active", job);
        handlers.active?.(job);
    });
    queue.on("completed", (job, result) => {
        handlers.record?.(name, "completed", job);
        handlers.completed?.(job, result as Result);
    });
    queue.on("failed", (job, error) => {
        if (job || handlers.recordFailedWithoutJob) {
            handlers.record?.(name, "failed", job as Bull.Job<JobData>);
        }
        handlers.failed?.(job, error);
    });
}
