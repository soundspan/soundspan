import { Registry } from "prom-client";
import { createVibeEmbedMetrics } from "../vibeEmbedMetrics";

describe("vibe embed metrics", () => {
    it("emits every bounded job outcome", async () => {
        const registry = new Registry();
        const metrics = createVibeEmbedMetrics(registry);

        for (const outcome of [
            "stored",
            "embed_failed",
            "invalid_payload",
            "track_missing",
            "stale_claim",
        ] as const) {
            metrics.recordJob(outcome);
        }

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_embed_jobs_total{outcome="stored"} 1',
        );
        expect(exposition).toContain('outcome="embed_failed"} 1');
        expect(exposition).toContain('outcome="invalid_payload"} 1');
        expect(exposition).toContain('outcome="track_missing"} 1');
        expect(exposition).toContain('outcome="stale_claim"} 1');
    });

    it("publishes active-space coverage by bounded state", async () => {
        const registry = new Registry();
        const metrics = createVibeEmbedMetrics(registry);

        metrics.setCoverage({ embedded: 8, pending: 3, failed: 2 });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_embedding_coverage{state="embedded"} 8',
        );
        expect(exposition).toContain('state="pending"} 3');
        expect(exposition).toContain('state="failed"} 2');
    });
});
