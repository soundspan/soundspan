import { Gauge, type Registry } from "prom-client";

const MAX_MONITORED_QUEUES = 64;
const QUEUE_STATES = ["waiting", "delayed", "active", "failed"] as const;

interface QueueCounts {
    waiting?: number;
    delayed?: number;
    active?: number;
    failed?: number;
}

/** Minimal Bull queue surface required for scrape-time collection. */
export interface MetricsQueue {
    name: string;
    getJobCounts(...types: string[]): Promise<QueueCounts>;
}

/** Registers scrape-time Bull queue gauges against a registry. */
export function registerQueueMetrics(
    registry: Registry,
    queues: readonly MetricsQueue[],
): Gauge<"queue" | "state"> {
    if (queues.length > MAX_MONITORED_QUEUES) {
        throw new Error(
            `Queue metric registration exceeds ${MAX_MONITORED_QUEUES} queues`,
        );
    }

    return new Gauge({
        name: "soundspan_queue_jobs",
        help: "Current Bull jobs by queue and bounded state.",
        labelNames: ["queue", "state"] as const,
        registers: [registry],
        async collect() {
            this.reset();
            for (let index = 0; index < MAX_MONITORED_QUEUES; index += 1) {
                const queue = queues[index];
                if (!queue) break;
                const counts = await queue.getJobCounts(...QUEUE_STATES);
                this.set(
                    { queue: queue.name, state: "depth" },
                    (counts.waiting ?? 0) + (counts.delayed ?? 0),
                );
                this.set(
                    { queue: queue.name, state: "active" },
                    counts.active ?? 0,
                );
                this.set(
                    { queue: queue.name, state: "failed" },
                    counts.failed ?? 0,
                );
            }
        },
    });
}
