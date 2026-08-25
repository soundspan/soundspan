jest.mock("../../config", () => ({
    config: {
        workers: { loudnessBackfillBatchSize: 100 },
    },
}));

import { Registry } from "prom-client";
import { createSchedulerMetrics } from "../schedulerMetrics";
import { SCHEDULER_JOB_TYPES } from "../../workers/schedulerJobTypes";

describe("scheduler metrics", () => {
    it("records bounded timeout, duration, and last-success labels", async () => {
        const registry = new Registry();
        const metrics = createSchedulerMetrics(registry);

        metrics.timeouts.inc({ operation: "getReconciliationSnapshot" });
        metrics.jobDuration.observe(
            { job: SCHEDULER_JOB_TYPES.reconciliation },
            6 * 60 * 60,
        );
        metrics.lastSuccess.set(
            { job: SCHEDULER_JOB_TYPES.reconciliation },
            1_700_000_000,
        );

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_scheduler_timeouts_total{operation="getReconciliationSnapshot"} 1',
        );
        expect(exposition).toContain(
            'soundspan_scheduler_job_duration_seconds_bucket{le="7200",job="download-reconciliation-cycle"} 0',
        );
        expect(exposition).toContain(
            'soundspan_scheduler_job_duration_seconds_bucket{le="14400",job="download-reconciliation-cycle"} 0',
        );
        expect(exposition).toContain(
            'soundspan_scheduler_job_duration_seconds_bucket{le="21600",job="download-reconciliation-cycle"} 1',
        );
        expect(exposition).toContain(
            'soundspan_scheduler_job_duration_seconds_sum{job="download-reconciliation-cycle"} 21600',
        );
        expect(exposition).toContain(
            'soundspan_scheduler_job_last_success_timestamp_seconds{job="download-reconciliation-cycle"} 1700000000',
        );
    });
});
