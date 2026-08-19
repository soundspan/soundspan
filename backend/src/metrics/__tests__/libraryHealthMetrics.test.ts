import { Registry } from "prom-client";
import { createLibraryHealthMetrics } from "../libraryHealthMetrics";

describe("library health metrics", () => {
    it("registers bounded cache labels", async () => {
        const registry = new Registry();
        const metrics = createLibraryHealthMetrics(registry);
        metrics.cacheResults.inc({ panel: "duplicates", result: "hit" });
        metrics.cacheResults.inc({ panel: "summary", result: "error" });
        const exposition = await registry.metrics();
        expect(exposition).toContain(
            "# HELP soundspan_library_health_cache_total",
        );
        expect(exposition).toContain('panel="duplicates",result="hit"} 1');
        expect(exposition).toContain('panel="summary",result="error"} 1');
    });
});
