import fs from "fs";
import path from "path";

describe("worker health endpoint contract", () => {
    const workerEntryPath = path.join(__dirname, "..", "worker.ts");
    const workerSource = fs.readFileSync(workerEntryPath, "utf8");

    it("exposes worker live/ready endpoints", () => {
        expect(workerSource).toContain('path === "/health/live"');
        expect(workerSource).toContain('path === "/health/ready"');
    });

    it("gates readiness by startup/drain lifecycle", () => {
        expect(workerSource).toContain("!isStartupComplete ||");
        expect(workerSource).toContain("isDraining ||");
        expect(workerSource).toContain(
            "createDependencyReadinessTracker(\"worker\")"
        );
        expect(workerSource).toContain("dependencyReadiness.isHealthy()");
        expect(workerSource).toContain("isStartupComplete = true");
        expect(workerSource).toContain("isDraining = true");
    });

    it("uses configurable worker health port", () => {
        expect(workerSource).toContain("WORKER_HEALTH_PORT");
        expect(workerSource).toContain("DEFAULT_WORKER_HEALTH_PORT");
    });
});
