import fs from "fs";
import path from "path";

describe("podcast download prisma retry contract", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../podcastDownload.ts"),
        "utf8"
    );

    it("retries transient prisma engine disconnect failures", () => {
        expect(source).toContain("withPodcastDownloadPrismaRetry(");
        expect(source).toContain("Response from the Engine was empty");
        expect(source).toContain("Engine has already exited");
        expect(source).toContain("PODCAST_DOWNLOAD_PRISMA_RETRY_ATTEMPTS = 3");
    });

    it("uses retry wrapper on hot-path podcast download reads and writes", () => {
        expect(source).toContain(
            "getCachedFilePath.podcastEpisode.findUnique"
        );
        expect(source).toContain(
            "performDownload.podcastDownload.upsert"
        );
        expect(source).toContain(
            "cleanupExpiredCache.podcastDownload.findMany"
        );
    });
});
