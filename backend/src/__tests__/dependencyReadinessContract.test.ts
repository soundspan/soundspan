import fs from "fs";
import path from "path";

describe("dependency readiness contract", () => {
    const trackerPath = path.resolve(
        __dirname,
        "../utils/dependencyReadiness.ts"
    );
    const trackerSource = fs.readFileSync(trackerPath, "utf8");

    it("supports env-driven dependency readiness controls", () => {
        expect(trackerSource).toContain("READINESS_REQUIRE_DEPENDENCIES");
        expect(trackerSource).toContain(
            "READINESS_DEPENDENCY_CHECK_INTERVAL_MS"
        );
        expect(trackerSource).toContain(
            "READINESS_DEPENDENCY_CHECK_TIMEOUT_MS"
        );
    });

    it("probes both postgres and redis for readiness", () => {
        expect(trackerSource).toContain("probePostgres");
        expect(trackerSource).toContain("probeRedis");
        expect(trackerSource).toContain("redisClient.isReady");
        expect(trackerSource).toContain("prisma.$queryRaw`SELECT 1`");
    });
});
