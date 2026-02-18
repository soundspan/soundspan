import fs from "fs";
import path from "path";

describe("discover queue handler contract", () => {
    it("registers a processor for recommendation-mode named jobs", () => {
        const workersPath = path.resolve(
            __dirname,
            "../workers/index.ts"
        );
        const workersSource = fs.readFileSync(workersPath, "utf8");

        expect(workersSource).toContain(
            `discoverQueue.process("discover-recommendation", processDiscoverWeekly);`
        );
    });

    it("keeps legacy unnamed discover processor registration", () => {
        const workersPath = path.resolve(
            __dirname,
            "../workers/index.ts"
        );
        const workersSource = fs.readFileSync(workersPath, "utf8");

        expect(workersSource).toContain(
            "discoverQueue.process(processDiscoverWeekly);"
        );
    });

    it("enqueues recommendation mode discovery job with matching name", () => {
        const discoverRoutePath = path.resolve(
            __dirname,
            "../routes/discover.ts"
        );
        const discoverRouteSource = fs.readFileSync(discoverRoutePath, "utf8");

        expect(discoverRouteSource).toContain(
            'const job = await discoverQueue.add(\n                "discover-recommendation",'
        );
    });

    it("uses deterministic manual job ids to dedupe generate requests", () => {
        const discoverRoutePath = path.resolve(
            __dirname,
            "../routes/discover.ts"
        );
        const discoverRouteSource = fs.readFileSync(discoverRoutePath, "utf8");

        expect(discoverRouteSource).toContain(
            "const manualJobId = `discover:manual:${userId}`;"
        );
        expect(discoverRouteSource).toContain(
            "const existingJob = await discoverQueue.getJob(manualJobId);"
        );
        expect(discoverRouteSource).toContain("jobId: manualJobId,");
    });

    it("uses recommendation-mode jobs and weekly idempotent ids in cron", () => {
        const discoverCronPath = path.resolve(
            __dirname,
            "../workers/discoverCron.ts"
        );
        const discoverCronSource = fs.readFileSync(discoverCronPath, "utf8");

        expect(discoverCronSource).toContain(
            "await discoverQueue.add("
        );
        expect(discoverCronSource).toContain(
            '"discover-recommendation"'
        );
        expect(discoverCronSource).toContain(
            "return `discover:cron:${weekKey}:${userId}`;"
        );
        expect(discoverCronSource).toContain("jobId,");
    });
});
