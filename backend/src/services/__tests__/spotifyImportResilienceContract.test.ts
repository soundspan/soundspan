import fs from "fs";
import path from "path";

describe("spotify import resilience contract", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../spotifyImport.ts"),
        "utf8"
    );

    it("defines prisma retry wrapper/proxy for high-volume import queries", () => {
        expect(source).toContain("withSpotifyImportPrismaRetry(");
        expect(source).toContain("createPrismaRetryProxy(");
        expect(source).toContain("SPOTIFY_IMPORT_PRISMA_RETRY_ATTEMPTS = 3");
        expect(source).toContain("const spotifyImportPrisma = createPrismaRetryProxy(");
    });

    it("adds redis reconnect-and-retry behavior for import job cache operations", () => {
        expect(source).toContain("withSpotifyImportRedisRetry(");
        expect(source).toContain("recreateSpotifyImportRedisClient(");
        expect(source).toContain("spotifyImportRedis.setEx(");
        expect(source).toContain("spotifyImportRedis.get(");
    });
});
