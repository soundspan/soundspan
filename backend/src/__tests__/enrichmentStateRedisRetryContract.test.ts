import fs from "fs";
import path from "path";

describe("enrichment state redis retry contract", () => {
    const servicePath = path.resolve(
        __dirname,
        "../services/enrichmentState.ts"
    );
    const source = fs.readFileSync(servicePath, "utf8");

    it("retries enrichment state operations on transient redis closure", () => {
        expect(source).toContain("private isRetryableRedisError(");
        expect(source).toContain('message.includes("Connection is closed")');
        expect(source).toContain("private async withStateRetry<T>(");
        expect(source).toContain("this.recreateStateClient()");
        expect(source).toContain("ENRICHMENT_STATE_REDIS_RETRY_ATTEMPTS");
        expect(source).toContain(
            "failed due to Redis connection closure (attempt"
        );
    });

    it("retries publisher operations on transient redis closure", () => {
        expect(source).toContain("private async withPublisherRetry<T>(");
        expect(source).toContain("this.recreatePublisherClient()");
        expect(source).toContain("ENRICHMENT_PUBLISHER_REDIS_RETRY_ATTEMPTS");
        expect(source).toContain("pause publish");
        expect(source).toContain("resume publish");
        expect(source).toContain("stop publish");
    });
});
