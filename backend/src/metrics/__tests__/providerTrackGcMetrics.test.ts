import { Registry } from "prom-client";
import { createProviderTrackGcMetrics } from "../providerTrackGcMetrics";

describe("provider track garbage collection metrics", () => {
    it("records bounded provider deletion counts and pass outcomes", async () => {
        const registry = new Registry();
        const metrics = createProviderTrackGcMetrics(registry);

        metrics.record(
            "success",
            0.25,
            { tidal: 2, youtube: 3 },
            {
                backlog: { tidal: 11, youtube: 12 },
                oldestCollectableAgeSeconds: {
                    tidal: 86_400,
                    youtube: 172_800,
                },
            },
        );
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
        expect(exposition).toContain(
            'soundspan_provider_track_gc_backlog{provider="tidal"} 11',
        );
        expect(exposition).toContain(
            'soundspan_provider_track_gc_backlog{provider="youtube"} 12',
        );
        expect(exposition).toContain(
            'soundspan_provider_track_gc_oldest_collectable_age_seconds{provider="tidal"} 86400',
        );
        expect(exposition).toContain(
            'soundspan_provider_track_gc_oldest_collectable_age_seconds{provider="youtube"} 172800',
        );
    });
});
