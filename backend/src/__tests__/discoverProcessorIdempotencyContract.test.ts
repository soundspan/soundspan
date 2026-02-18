import fs from "fs";
import path from "path";

describe("discover processor idempotency contract", () => {
    const processorPath = path.resolve(
        __dirname,
        "../workers/processors/discoverProcessor.ts"
    );
    const source = fs.readFileSync(processorPath, "utf8");

    it("uses a per-user redis claim lock before generating playlists", () => {
        expect(source).toContain("discover:processor:lock");
        expect(source).toContain(
            'createIORedisClient(\n    "discover-processor-locks"'
        );
        expect(source).toContain("DISCOVER_PROCESSOR_LOCK_TTL_MS");
        expect(source).toContain('"NX"');
        expect(source).toContain("withDiscoverLockRedisRetry(");
        expect(source).toContain("recreating client and retrying once");
        expect(source).toContain("processDiscoverWeekly");
    });

    it("skips duplicate in-flight jobs instead of executing side effects twice", () => {
        expect(source).toContain("Skipping generation for user");
        expect(source).toContain("skipped: true");
    });

    it("releases lock ownership with token compare-and-delete semantics", () => {
        expect(source).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
        expect(source).toContain("Failed to release processor claim");
    });
});
