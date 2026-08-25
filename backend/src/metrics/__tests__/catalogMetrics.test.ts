import { Registry } from "prom-client";
import { createCatalogMetrics } from "../catalogMetrics";

describe("catalog metrics", () => {
    it("registers catalog gauges and counters with the closed write-kind label", async () => {
        const registry = new Registry();
        const metrics = createCatalogMetrics(registry);

        metrics.albums.set(12);
        metrics.writes.inc({ kind: "release_group" }, 2);
        metrics.writes.inc({ kind: "tracklist" });
        metrics.reaped.inc(3);

        const exposition = await registry.metrics();
        expect(exposition).toContain("soundspan_catalog_albums 12");
        expect(exposition).toContain(
            'soundspan_catalog_writes_total{kind="release_group"} 2',
        );
        expect(exposition).toContain(
            'soundspan_catalog_writes_total{kind="tracklist"} 1',
        );
        expect(exposition).toContain("soundspan_catalog_reaped_total 3");
    });
});
