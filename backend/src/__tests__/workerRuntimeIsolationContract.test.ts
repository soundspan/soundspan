import fs from "fs";
import path from "path";

describe("worker runtime isolation contract", () => {
    const indexPath = path.resolve(__dirname, "../index.ts");
    const workerPath = path.resolve(__dirname, "../worker.ts");
    const indexSource = fs.readFileSync(indexPath, "utf8");
    const workerSource = fs.readFileSync(workerPath, "utf8");

    it("blocks worker role usage on API entrypoint", () => {
        expect(indexSource).toContain('BACKEND_PROCESS_ROLE="worker"');
        expect(indexSource).toContain("Use worker entrypoint");
    });

    it("blocks api role usage on worker entrypoint", () => {
        expect(workerSource).toContain('BACKEND_PROCESS_ROLE="api"');
        expect(workerSource).toContain("invalid for worker entrypoint");
    });

    it("keeps worker queue bootstrap on worker entrypoint", () => {
        expect(workerSource).toContain('await import("./workers")');
        expect(workerSource).toContain("workersInitialized = true");
    });
});
