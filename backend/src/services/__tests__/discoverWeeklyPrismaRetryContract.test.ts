import fs from "fs";
import path from "path";

describe("discover weekly prisma retry contract", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../discoverWeekly.ts"),
        "utf8"
    );

    it("defines transient prisma retry wrapper and proxy", () => {
        expect(source).toContain("withDiscoverWeeklyPrismaRetry(");
        expect(source).toContain("createPrismaRetryProxy(");
        expect(source).toContain("DISCOVER_WEEKLY_PRISMA_RETRY_ATTEMPTS = 3");
        expect(source).toContain("await discoverWeeklyBasePrisma.$connect().catch(() => {});");
    });

    it("routes hot-path queries through retry proxied prisma client", () => {
        expect(source).toContain("const discoverWeeklyPrisma = createPrismaRetryProxy(");
        expect(source).toContain("discoverWeeklyPrisma.track.findMany(");
        expect(source).toContain("discoverWeeklyPrisma.discoveryBatch.findMany(");
        expect(source).toContain("discoverWeeklyPrisma.downloadJob.findMany(");
    });
});
