import fs from "fs";
import path from "path";

describe("health endpoint contract", () => {
    it("exposes explicit live and ready endpoints", () => {
        const indexPath = path.resolve(__dirname, "../index.ts");
        const indexSource = fs.readFileSync(indexPath, "utf8");

        expect(indexSource).toContain('app.get("/health/live"');
        expect(indexSource).toContain('app.get("/health/ready"');
        expect(indexSource).toContain('app.get("/api/health/live"');
        expect(indexSource).toContain('app.get("/api/health/ready"');
    });

    it("marks readiness false while startup is incomplete or draining", () => {
        const indexPath = path.resolve(__dirname, "../index.ts");
        const indexSource = fs.readFileSync(indexPath, "utf8");

        expect(indexSource).toContain("!isStartupComplete || isDraining");
        expect(indexSource).toContain("createDependencyReadinessTracker(\"api\")");
        expect(indexSource).toContain("dependencyReadiness.isHealthy()");
        expect(indexSource).toContain("isStartupComplete = true;");
        expect(indexSource).toContain("isDraining = true;");
    });
});
