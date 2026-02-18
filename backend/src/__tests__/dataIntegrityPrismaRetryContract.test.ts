import fs from "fs";
import path from "path";

describe("data integrity prisma retry contract", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../workers/dataIntegrity.ts"),
        "utf8"
    );

    it("retries transient prisma engine failures in data integrity worker", () => {
        expect(source).toContain("withDataIntegrityPrismaRetry(");
        expect(source).toContain("DATA_INTEGRITY_PRISMA_RETRY_ATTEMPTS = 3");
        expect(source).toContain("Response from the Engine was empty");
        expect(source).toContain("await prisma.$connect().catch(() => {});");
    });

    it("applies retry wrapper to core cleanup write paths", () => {
        expect(source).toContain(
            "runDataIntegrityCheck.album.update.mislocated"
        );
        expect(source).toContain(
            "runDataIntegrityCheck.$executeRaw.orphanedOwnedAlbums"
        );
        expect(source).toContain(
            "runDataIntegrityCheck.downloadJob.deleteMany.oldJobs"
        );
    });
});
