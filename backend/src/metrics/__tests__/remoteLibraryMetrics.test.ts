import { Registry } from "prom-client";
import { createRemoteLibraryMetrics } from "../remoteLibraryMetrics";

describe("remote library metrics", () => {
    it("registers the capped-row counter with bounded provider labels", async () => {
        const registry = new Registry();
        const metrics = createRemoteLibraryMetrics(registry);
        metrics.rowsCapped.inc({ provider: "tidal" });
        metrics.rowsCapped.inc({ provider: "youtube" }, 2);

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_library_remote_rows_capped_total{provider="tidal"} 1',
        );
        expect(exposition).toContain(
            'soundspan_library_remote_rows_capped_total{provider="youtube"} 2',
        );
    });
});
