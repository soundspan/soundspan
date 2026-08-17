import { Registry } from "prom-client";
import { createVibeEmbedMetrics } from "../vibeEmbedMetrics";

describe("vibe embed metrics", () => {
    function createMetrics(registry: Registry, queueDepth = 0) {
        const getProviderQueueDepth = jest.fn(async () => queueDepth);
        return {
            metrics: createVibeEmbedMetrics(registry, {
                getProviderQueueDepth,
            }),
            getProviderQueueDepth,
        };
    }

    it("emits every bounded job outcome", async () => {
        const registry = new Registry();
        const { metrics } = createMetrics(registry);

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
        const { metrics } = createMetrics(registry);

        metrics.setCoverage({ embedded: 8, pending: 3, failed: 2 });

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_embedding_coverage{state="embedded"} 8',
        );
        expect(exposition).toContain('state="pending"} 3');
        expect(exposition).toContain('state="failed"} 2');
    });

    it("emits every bounded space transition", async () => {
        const registry = new Registry();
        const { metrics } = createMetrics(registry);

        for (const transition of [
            "registered",
            "cutover",
            "retired_cleaned",
        ] as const) {
            metrics.recordSpaceTransition(transition);
        }

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_space_transitions_total{transition="registered"} 1',
        );
        expect(exposition).toContain('transition="cutover"} 1');
        expect(exposition).toContain('transition="retired_cleaned"} 1');
    });

    it("emits bounded provider configuration errors", async () => {
        const registry = new Registry();
        const { metrics } = createMetrics(registry);

        metrics.recordProviderConfigError("preprocessing_mismatch");

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_provider_config_errors_total{reason="preprocessing_mismatch"} 1',
        );
    });

    it("emits bounded vocabulary space mismatch reasons", async () => {
        const registry = new Registry();
        const { metrics } = createMetrics(registry);

        metrics.recordVocabularySpaceMismatch("missing_identity");
        metrics.recordVocabularySpaceMismatch("space_mismatch");

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_vocabulary_space_mismatches_total{reason="missing_identity"} 1',
        );
        expect(exposition).toContain('reason="space_mismatch"} 1');
    });

    it("collects raw provider queue depth only on the scrape cadence", async () => {
        const registry = new Registry();
        const { getProviderQueueDepth } = createMetrics(registry, 7);

        expect(getProviderQueueDepth).not.toHaveBeenCalled();

        const exposition = await registry.metrics();

        expect(getProviderQueueDepth).toHaveBeenCalledTimes(1);
        expect(exposition).toContain("soundspan_vibe_provider_queue_depth 7");
    });
});
