import { Registry } from "prom-client";
import { createRequestMetrics, MUSIC_REQUEST_ACTIONS } from "../requestMetrics";

describe("request metrics", () => {
    it("registers the closed action counter in the supplied registry", async () => {
        const registry = new Registry();
        const metrics = createRequestMetrics(registry);

        for (const action of MUSIC_REQUEST_ACTIONS) {
            metrics.requests.inc({ action });
        }

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            "# TYPE soundspan_music_requests_total counter",
        );
        for (const action of MUSIC_REQUEST_ACTIONS) {
            expect(exposition).toContain(
                `soundspan_music_requests_total{action="${action}"} 1`,
            );
        }
    });
});
