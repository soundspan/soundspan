import fs from "fs";
import path from "path";

describe("worker scheduler queue registration contract", () => {
    it("waits for scheduler queue readiness before registering startup jobs", () => {
        const workersPath = path.resolve(__dirname, "../workers/index.ts");
        const workersSource = fs.readFileSync(workersPath, "utf8");

        const start = workersSource.indexOf(
            "async function registerSchedulerJobs(): Promise<void> {"
        );
        const end = workersSource.indexOf(
            "// Register processors with named job types"
        );
        const registerBlock = workersSource.slice(start, end);

        expect(registerBlock).toContain("await schedulerQueue.isReady()");
        expect(registerBlock).toContain("for (const job of schedulerJobs)");
        expect(registerBlock).not.toContain("Promise.all([");
    });
});
