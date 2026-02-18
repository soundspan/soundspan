import fs from "fs";
import path from "path";

describe("worker scheduler claim contract", () => {
    it("uses Redis-backed claim helper for recurring scheduler loops", () => {
        const workersPath = path.resolve(__dirname, "../workers/index.ts");
        const workersSource = fs.readFileSync(workersPath, "utf8");

        expect(workersSource).toContain(
            'let schedulerLockRedis: Redis = createIORedisClient("worker-scheduler-locks");'
        );
        expect(workersSource).toContain("async function runWithSchedulerClaim(");
        expect(workersSource).toContain(
            "async function withSchedulerClaimRedisRetry<"
        );
        expect(workersSource).toContain(
            "failed due to Redis connection closure (attempt"
        );
        expect(workersSource).toContain(
            '"scheduler-claim:reconciliation-cycle"'
        );
        expect(workersSource).toContain(
            '"scheduler-claim:lidarr-cleanup-cycle"'
        );
        expect(workersSource).toContain('"scheduler-claim:data-integrity"');
        expect(workersSource).toContain(
            "SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD"
        );
    });

    it("registers queue-backed repeatable scheduler jobs", () => {
        const workersPath = path.resolve(__dirname, "../workers/index.ts");
        const workersSource = fs.readFileSync(workersPath, "utf8");

        expect(workersSource).toContain("schedulerQueue.add(");
        expect(workersSource).toContain("repeat: { every: 24 * ONE_HOUR_MS }");
        expect(workersSource).toContain(
            "repeat: { every: 2 * ONE_MINUTE_MS }"
        );
        expect(workersSource).toContain(
            "repeat: { every: 5 * ONE_MINUTE_MS }"
        );
        expect(workersSource).toContain(
            'schedulerQueue.process("*", async (job: Bull.Job<any>) =>'
        );
        expect(workersSource).toContain("await processSchedulerJob(job);");
        expect(workersSource).not.toContain("runReconciliationCycle");
        expect(workersSource).not.toContain("runLidarrCleanupCycle");
    });
});
