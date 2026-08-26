import { Registry } from "prom-client";
import { createSoulseekAlbumMetrics } from "../soulseekAlbumMetrics";

describe("Soulseek album metrics", () => {
    it("registers bounded folder outcomes and coherence scores", async () => {
        const registry = new Registry();
        const metrics = createSoulseekAlbumMetrics(registry);

        metrics.record("folder_selected", 0.91);
        metrics.record("per_track_fallback", 0.62);

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_soulseek_album_folder_decisions_total{outcome="folder_selected"} 1',
        );
        expect(exposition).toContain(
            "soundspan_soulseek_album_coherence_score_sum 1.53",
        );
    });
});
