import fs from "fs";
import path from "path";

describe("mood bucket worker reconciliation contract", () => {
    it("reprocesses tracks that were re-analyzed after bucket assignment", () => {
        const workerPath = path.resolve(
            __dirname,
            "../workers/moodBucketWorker.ts"
        );
        const source = fs.readFileSync(workerPath, "utf8");

        expect(source).toContain(`COUNT(mb.*) = 0`);
        expect(source).toContain(`MAX(mb."updatedAt") < t."analyzedAt"`);
        expect(source).toContain("mood bucket reconciliation");
    });
});
