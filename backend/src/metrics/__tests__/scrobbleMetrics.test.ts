import { Registry } from "prom-client";
import { createScrobbleMetrics } from "../scrobbleMetrics";

describe("createScrobbleMetrics", () => {
    it("registers the closed service and outcome labels", async () => {
        const registry = new Registry();
        const metrics = createScrobbleMetrics(registry);

        metrics.submissions.inc({ service: "lastfm", outcome: "submitted" });
        metrics.submissions.inc({
            service: "listenbrainz",
            outcome: "invalid_auth",
        });

        const output = await registry.metrics();
        expect(output).toContain(
            'soundspan_scrobble_forwarding_total{service="lastfm",outcome="submitted"} 1',
        );
        expect(output).toContain(
            'soundspan_scrobble_forwarding_total{service="listenbrainz",outcome="invalid_auth"} 1',
        );
    });
});
