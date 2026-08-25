import fs from "fs";
import path from "path";

describe("queue cleaner prisma retry contract", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../jobs/queueCleaner.ts"),
        "utf8",
    );
    const retrySource = fs.readFileSync(
        path.resolve(__dirname, "../utils/prismaRetry.ts"),
        "utf8",
    );

    it("retries transient prisma failures for queue-cleaner loops", () => {
        expect(source).toContain("withPrismaRetry(");
        expect(retrySource).toContain("Response from the Engine was empty");
        expect(retrySource).toContain("P2037");
        expect(retrySource).toContain(
            "await prisma.$connect().catch(() => {});",
        );
    });

    it("uses retry wrapper for reconciliation and recovery updates", () => {
        expect(source).toContain("runCleanup.downloadJob.findMany.orphaned");
        expect(source).toContain(
            "runCleanup.downloadJob.updateMany.recoverCompleted",
        );
        expect(source).toContain(
            "reconcileWithLocalLibrary.downloadJob.updateMany.complete",
        );
    });
});
