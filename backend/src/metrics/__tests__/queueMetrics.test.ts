import { Registry } from "prom-client";
import { registerQueueMetrics } from "../queueMetrics";

describe("queue metrics", () => {
    it("collects waiting, delayed, active, and failed counts on scrape", async () => {
        const getJobCounts = jest.fn().mockResolvedValue({
            waiting: 4,
            delayed: 3,
            active: 2,
            failed: 1,
        });
        const registry = new Registry();
        registerQueueMetrics(registry, [
            { name: "library-scan", getJobCounts },
        ]);

        expect(getJobCounts).not.toHaveBeenCalled();

        const exposition = await registry.metrics();

        expect(getJobCounts).toHaveBeenCalledWith(
            "waiting",
            "delayed",
            "active",
            "failed",
        );
        expect(exposition).toContain(
            'soundspan_queue_jobs{queue="library-scan",state="depth"} 7',
        );
        expect(exposition).toContain(
            'soundspan_queue_jobs{queue="library-scan",state="active"} 2',
        );
        expect(exposition).toContain(
            'soundspan_queue_jobs{queue="library-scan",state="failed"} 1',
        );
    });
});
