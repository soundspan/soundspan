import fs from "fs";
import path from "path";

describe("worker scheduler claim contract", () => {
    it("registers queue-backed repeatable scheduler jobs", () => {
        const workersPath = path.resolve(__dirname, "../workers/index.ts");
        const workersSource = fs.readFileSync(workersPath, "utf8");
        const registryPath = path.resolve(
            __dirname,
            "../workers/schedulerJobRegistry.ts",
        );
        const registrySource = fs.readFileSync(registryPath, "utf8");

        expect(workersSource).toContain("schedulerQueue.add(");
        expect(workersSource).toContain("buildSchedulerJobs()");
        expect(registrySource).toContain("repeat: { every: 24 * ONE_HOUR_MS }");
        expect(registrySource).toContain(
            "repeat: { every: 2 * ONE_MINUTE_MS }",
        );
        expect(registrySource).toContain(
            "repeat: { every: 5 * ONE_MINUTE_MS }",
        );
        expect(workersSource).toContain(
            'schedulerQueue.process("*", async (job: Bull.Job<any>) =>',
        );
        expect(workersSource).toContain("await processSchedulerJob(job);");
        expect(workersSource).not.toContain("runReconciliationCycle");
        expect(workersSource).not.toContain("runLidarrCleanupCycle");
    });
});
