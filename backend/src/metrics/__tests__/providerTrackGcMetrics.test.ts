import { Registry } from "prom-client";
import { createProviderTrackGcMetrics } from "../providerTrackGcMetrics";

describe("provider track garbage collection metrics", () => {
    it("records bounded provider deletion counts and pass outcomes", async () => {
        const registry = new Registry();
        const metrics = createProviderTrackGcMetrics(registry);

        metrics.record("success", 0.25, { tidal: 2, youtube: 3 });
        metrics.record("failure", 0.5, { tidal: 0, youtube: 0 });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_provider_track_gc_deleted_total{provider="tidal"} 2',
        );
        expect(exposition).toContain(
            'soundspan_provider_track_gc_deleted_total{provider="youtube"} 3',
        );
        expect(exposition).toContain(
            'soundspan_provider_track_gc_pass_seconds_sum{outcome="success"} 0.25',
        );
        expect(exposition).toContain(
            'soundspan_provider_track_gc_pass_seconds_sum{outcome="failure"} 0.5',
        );
    });
});
