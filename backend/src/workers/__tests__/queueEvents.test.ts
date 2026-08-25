import type Bull from "bull";

import { registerQueueProcessorEvents } from "../queueEvents";

describe("registerQueueProcessorEvents", () => {
    it("registers active, completed, and failed handlers with common event recording", () => {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const on = jest.fn(
            (event: string, handler: (...args: unknown[]) => void): void => {
                listeners.set(event, handler);
            },
        );
        const queue = { on } as unknown as Bull.Queue;
        const record = jest.fn();
        const active = jest.fn();
        const completed = jest.fn();
        const failed = jest.fn();
        const job = { id: "job-1" };
        const error = new Error("failed");

        registerQueueProcessorEvents(queue, "test-queue", {
            record,
            active,
            completed,
            failed,
        });
        listeners.get("active")?.(job);
        listeners.get("completed")?.(job, { ok: true });
        listeners.get("failed")?.(job, error);

        expect(on.mock.calls.map(([event]) => event)).toEqual([
            "active",
            "completed",
            "failed",
        ]);
        expect(record.mock.calls).toEqual([
            ["test-queue", "active", job],
            ["test-queue", "completed", job],
            ["test-queue", "failed", job],
        ]);
        expect(active).toHaveBeenCalledWith(job);
        expect(completed).toHaveBeenCalledWith(job, { ok: true });
        expect(failed).toHaveBeenCalledWith(job, error);
    });

    it("preserves a failed event with no job for an override guard", () => {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const on = jest.fn(
            (event: string, handler: (...args: unknown[]) => void): void => {
                listeners.set(event, handler);
            },
        );
        const queue = { on } as unknown as Bull.Queue;
        const record = jest.fn();
        const failed = jest.fn();
        const error = new Error("missing job");

        registerQueueProcessorEvents(queue, "test-queue", { record, failed });
        listeners.get("failed")?.(undefined, error);

        expect(record).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledWith(undefined, error);
    });

    it("can preserve legacy queues that recorded missing failed jobs", () => {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const on = jest.fn(
            (event: string, handler: (...args: unknown[]) => void): void => {
                listeners.set(event, handler);
            },
        );
        const queue = { on } as unknown as Bull.Queue;
        const record = jest.fn();
        const error = new Error("missing job");

        registerQueueProcessorEvents(queue, "legacy-queue", {
            record,
            recordFailedWithoutJob: true,
        });
        listeners.get("failed")?.(undefined, error);

        expect(record).toHaveBeenCalledWith(
            "legacy-queue",
            "failed",
            undefined,
        );
    });
});
