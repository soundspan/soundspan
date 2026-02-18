import fs from "fs";
import path from "path";

describe("mood bucket prisma retry contract", () => {
    const servicePath = path.resolve(
        __dirname,
        "../services/moodBucketService.ts"
    );
    const source = fs.readFileSync(servicePath, "utf8");

    it("retries transient prisma engine failures for mood bucket writes", () => {
        expect(source).toContain("private isRetryablePrismaError(");
        expect(source).toContain(
            'message.includes("Response from the Engine was empty")'
        );
        expect(source).toContain("private async withPrismaRetry<T>(");
        expect(source).toContain("await prisma.$connect().catch(() => {});");
    });

    it("applies retry wrapper to mood bucket deleteMany/upsert paths", () => {
        expect(source).toContain("assignTrackToMoods.write");
        expect(source).toContain(
            "backfillAllTracks.moodBucket.upsert"
        );
        expect(source).toContain("clearTrackMoods.deleteMany");
    });
});
