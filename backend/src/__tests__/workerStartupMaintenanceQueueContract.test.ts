import fs from "fs";
import path from "path";

describe("worker startup maintenance queue contract", () => {
    const workersPath = path.resolve(__dirname, "../workers/index.ts");
    const indexPath = path.resolve(__dirname, "../index.ts");
    const workerPath = path.resolve(__dirname, "../worker.ts");

    const workersSource = fs.readFileSync(workersPath, "utf8");
    const indexSource = fs.readFileSync(indexPath, "utf8");
    const workerSource = fs.readFileSync(workerPath, "utf8");

    it("registers startup maintenance via scheduler queue jobs", () => {
        expect(workersSource).toContain("cacheWarmup");
        expect(workersSource).toContain("podcastCleanup");
        expect(workersSource).toContain("audiobookAutoSync");
        expect(workersSource).toContain("downloadQueueReconcile");
        expect(workersSource).toContain("artistCountsBackfill");
        expect(workersSource).toContain("imageBackfill");
        expect(workersSource).toContain("repeat: { every: 24 * ONE_HOUR_MS }");
    });

    it("removes direct startup side-effects from api and worker entrypoints", () => {
        expect(indexSource).not.toContain("dataCacheService.warmupCache()");
        expect(indexSource).not.toContain("cleanupExpiredCache()");
        expect(indexSource).not.toContain("audiobookCacheService.syncAll()");
        expect(indexSource).not.toContain(
            "downloadQueueManager.reconcileOnStartup()"
        );
        expect(indexSource).not.toContain("backfillAllArtistCounts()");
        expect(indexSource).not.toContain("backfillAllImages()");

        expect(workerSource).not.toContain("dataCacheService.warmupCache()");
        expect(workerSource).not.toContain("cleanupExpiredCache()");
        expect(workerSource).not.toContain("audiobookCacheService.syncAll()");
        expect(workerSource).not.toContain(
            "downloadQueueManager.reconcileOnStartup()"
        );
        expect(workerSource).not.toContain("backfillAllArtistCounts()");
        expect(workerSource).not.toContain("backfillAllImages()");
    });
});
