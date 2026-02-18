import fs from "fs";
import path from "path";

describe("podcast refresh prisma retry compatibility", () => {
    const podcastsPath = path.resolve(__dirname, "../podcasts.ts");
    const source = fs.readFileSync(podcastsPath, "utf8");

    it("retries transient Prisma engine-empty failures during podcast refresh", () => {
        expect(source).toContain("withPodcastPrismaRetry(");
        expect(source).toContain("Response from the Engine was empty");
        expect(source).toContain("Engine has already exited");
        expect(source).toContain("PODCAST_PRISMA_RETRY_ATTEMPTS = 3");
    });

    it("uses createMany with skipDuplicates to reduce per-episode prisma churn", () => {
        const refreshStart = source.indexOf("export async function refreshPodcastFeed");
        expect(refreshStart).toBeGreaterThan(-1);

        const refreshSection = source.slice(refreshStart);
        expect(refreshSection).toContain("podcastEpisode.createMany");
        expect(refreshSection).toContain("skipDuplicates: true");
        expect(refreshSection).not.toContain("podcastId_guid");
    });
});
