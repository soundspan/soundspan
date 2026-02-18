import fs from "fs";
import path from "path";

describe("worker observability contract", () => {
    it("logs processor identity and scheduler ownership counters", () => {
        const workersPath = path.resolve(__dirname, "../workers/index.ts");
        const source = fs.readFileSync(workersPath, "utf8");

        expect(source).toContain("WORKER_PROCESSOR_ID");
        expect(source).toContain("[QueueProcessor/Identity]");
        expect(source).toContain("schedulerClaimCounters");
        expect(source).toContain("[SchedulerClaim/Observability]");
    });
});
