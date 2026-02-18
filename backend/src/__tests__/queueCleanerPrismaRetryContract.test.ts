import fs from "fs";
import path from "path";

describe("queue cleaner prisma retry contract", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../jobs/queueCleaner.ts"),
        "utf8"
    );

    it("retries transient prisma failures for queue-cleaner loops", () => {
        expect(source).toContain("private async withPrismaRetry<T>(");
        expect(source).toContain("Response from the Engine was empty");
        expect(source).toContain("[QueueCleaner/Prisma]");
        expect(source).toContain("await prisma.$connect().catch(() => {});");
    });

    it("uses retry wrapper for reconciliation and recovery updates", () => {
        expect(source).toContain("runCleanup.downloadJob.findMany.orphaned");
        expect(source).toContain(
            "runCleanup.downloadJob.updateMany.recoverCompleted"
        );
        expect(source).toContain(
            "reconcileWithLocalLibrary.downloadJob.updateMany.complete"
        );
    });
});
