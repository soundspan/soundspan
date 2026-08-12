import fs from "fs";
import path from "path";

describe("dependency readiness contract", () => {
    const trackerPath = path.resolve(
        __dirname,
        "../utils/dependencyReadiness.ts",
    );
    const trackerSource = fs.readFileSync(trackerPath, "utf8");

    it("probes both postgres and redis for readiness", () => {
        expect(trackerSource).toContain("probePostgres");
        expect(trackerSource).toContain("probeRedis");
        expect(trackerSource).toContain("redisClient.isReady");
        expect(trackerSource).toContain("prisma.$queryRaw`SELECT 1`");
    });
});
