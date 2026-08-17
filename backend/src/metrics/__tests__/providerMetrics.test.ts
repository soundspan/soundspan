import { Registry } from "prom-client";
import { createProviderMetrics } from "../providerMetrics";

describe("vibe provider metrics", () => {
    it("registers bounded endpoint and outcome labels", async () => {
        const registry = new Registry();
        const metrics = createProviderMetrics(registry);

        metrics.record("text", "ok", 0.125);
        metrics.record("space", "mismatch", 0.25);

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_provider_requests_total{endpoint="text",outcome="ok"} 1',
        );
        expect(exposition).toContain(
            'soundspan_vibe_provider_requests_total{endpoint="space",outcome="mismatch"} 1',
        );
        expect(exposition).toContain(
            'soundspan_vibe_provider_request_seconds_sum{endpoint="text"} 0.125',
        );
    });
});
