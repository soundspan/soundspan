import fs from "fs";
import path from "path";

describe("worker shutdown resilience contract", () => {
    const unifiedPath = path.resolve(
        __dirname,
        "../workers/unifiedEnrichment.ts",
    );

    const unifiedSource = fs.readFileSync(unifiedPath, "utf8");

    it("waits for active enrichment cycle and updates state before local redis teardown", () => {
        expect(unifiedSource).toContain(
            "export async function stopUnifiedEnrichmentWorker()",
        );
        expect(unifiedSource).toContain("await waitForActiveCycleToStop()");

        const stopFnStart = unifiedSource.indexOf(
            "export async function stopUnifiedEnrichmentWorker()",
        );
        expect(stopFnStart).toBeGreaterThan(-1);
        const stopFnSource = unifiedSource.slice(stopFnStart);

        const stateUpdateIndex = stopFnSource.indexOf(
            "await enrichmentStateService.updateState(",
        );
        const redisDisconnectIndex = stopFnSource.indexOf("redis.disconnect()");

        expect(stateUpdateIndex).toBeGreaterThan(-1);
        expect(redisDisconnectIndex).toBeGreaterThan(stateUpdateIndex);
    });
});
