import fs from "fs";
import path from "path";

describe("enrichment cycle claim contract", () => {
    const unifiedPath = path.resolve(__dirname, "../workers/unifiedEnrichment.ts");
    const moodPath = path.resolve(__dirname, "../workers/moodBucketWorker.ts");
    const unifiedSource = fs.readFileSync(unifiedPath, "utf8");
    const moodSource = fs.readFileSync(moodPath, "utf8");

    it("protects unified enrichment cycles with a distributed claim lock", () => {
        expect(unifiedSource).toContain("enrichment:cycle:claim");
        expect(unifiedSource).toContain('createIORedisClient("enrichment-cycle-claims")');
        expect(unifiedSource).toContain("runEnrichmentCycleClaimed(");
        expect(unifiedSource).toContain("withEnrichmentClaimRedisRetry(");
        expect(unifiedSource).toContain('"interval enrichment cycle"');
        expect(unifiedSource).toContain('"NX"');
    });

    it("protects mood bucket worker cycles with a distributed claim lock", () => {
        expect(moodSource).toContain("mood-bucket:cycle:claim");
        expect(moodSource).toContain('createIORedisClient("mood-bucket-cycle-claims")');
        expect(moodSource).toContain("processNewlyAnalyzedTracksClaimed(");
        expect(moodSource).toContain("withMoodBucketClaimRedisRetry(");
        expect(moodSource).toContain('"interval mood-bucket cycle"');
        expect(moodSource).toContain('"NX"');
    });

    it("uses compare-and-delete for claim release in both workers", () => {
        expect(unifiedSource).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
        expect(moodSource).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    });
});
