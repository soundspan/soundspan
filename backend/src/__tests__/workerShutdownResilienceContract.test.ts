import fs from "fs";
import path from "path";

describe("worker shutdown resilience contract", () => {
    const workersPath = path.resolve(__dirname, "../workers/index.ts");
    const unifiedPath = path.resolve(__dirname, "../workers/unifiedEnrichment.ts");

    const workersSource = fs.readFileSync(workersPath, "utf8");
    const unifiedSource = fs.readFileSync(unifiedPath, "utf8");

    it("awaits enrichment worker stop and keeps queue processing alive until queue close", () => {
        expect(workersSource).toContain("await stopUnifiedEnrichmentWorker()");

        const queueCloseIndex = workersSource.indexOf("await Promise.all([\n        scanQueue.close()");
        const enrichmentDisconnectIndex = workersSource.indexOf(
            "await enrichmentStateService.disconnect()"
        );
        const schedulerLockDisconnectIndex = workersSource.indexOf(
            "await schedulerLockRedis.quit()"
        );

        expect(queueCloseIndex).toBeGreaterThan(-1);
        expect(enrichmentDisconnectIndex).toBeGreaterThan(queueCloseIndex);
        expect(schedulerLockDisconnectIndex).toBeGreaterThan(queueCloseIndex);
    });

    it("waits for active enrichment cycle and updates state before local redis teardown", () => {
        expect(unifiedSource).toContain(
            "export async function stopUnifiedEnrichmentWorker()"
        );
        expect(unifiedSource).toContain("await waitForActiveCycleToStop()");

        const stopFnStart = unifiedSource.indexOf(
            "export async function stopUnifiedEnrichmentWorker()"
        );
        expect(stopFnStart).toBeGreaterThan(-1);
        const stopFnSource = unifiedSource.slice(stopFnStart);

        const stateUpdateIndex = stopFnSource.indexOf(
            "await enrichmentStateService.updateState("
        );
        const redisDisconnectIndex = stopFnSource.indexOf("redis.disconnect()");

        expect(stateUpdateIndex).toBeGreaterThan(-1);
        expect(redisDisconnectIndex).toBeGreaterThan(stateUpdateIndex);
    });
});
