import { Registry } from "prom-client";
import { createVibeEmbedMetrics } from "../vibeEmbedMetrics";

describe("vibe embed metrics", () => {
    function createMetrics(registry: Registry, queueDepth = 0) {
        const getProviderQueueDepth = jest.fn(async () => queueDepth);
        const getProviderStatusFresh = jest.fn(async () => true);
        return {
            metrics: createVibeEmbedMetrics(registry, {
                getProviderQueueDepth,
                getProviderStatusFresh,
            }),
            getProviderQueueDepth,
            getProviderStatusFresh,
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

    it("keeps the last queue depth and records a bounded collector error", async () => {
        const registry = new Registry();
        const getProviderQueueDepth = jest
            .fn<Promise<number>, []>()
            .mockResolvedValueOnce(7)
            .mockRejectedValueOnce(new Error("redis unavailable"));
        createVibeEmbedMetrics(registry, {
            getProviderQueueDepth,
            getProviderStatusFresh: jest.fn(async () => true),
        });

        const firstExposition = await registry.metrics();
        const degradedExposition = await registry.metrics();
        const nextExposition = await registry.metrics();

        expect(firstExposition).toContain(
            "soundspan_vibe_provider_queue_depth 7",
        );
        expect(degradedExposition).toContain(
            "soundspan_vibe_provider_queue_depth 7",
        );
        expect(nextExposition).toMatch(
            /soundspan_metrics_collection_errors_total\{collector="vibe_queue_depth"\} [1-9][0-9]*/,
        );
    });

    it("publishes queue capacity and migration state for alert ratios", async () => {
        const registry = new Registry();
        const { metrics } = createMetrics(registry);

        metrics.setProviderQueueCapacity(100);
        metrics.setMigrationActive(true);

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            "soundspan_vibe_provider_queue_capacity 100",
        );
        expect(exposition).toContain("soundspan_vibe_migration_active 1");
    });

    it("collects provider heartbeat freshness on each scrape", async () => {
        const registry = new Registry();
        const { getProviderStatusFresh } = createMetrics(registry);

        const exposition = await registry.metrics();

        expect(getProviderStatusFresh).toHaveBeenCalledTimes(1);
        expect(exposition).toContain("soundspan_vibe_provider_status_fresh 1");
    });

    it("publishes zero when no provider heartbeat is fresh", async () => {
        const registry = new Registry();
        createVibeEmbedMetrics(registry, {
            getProviderQueueDepth: jest.fn(async () => 0),
            getProviderStatusFresh: jest.fn(async () => false),
        });

        await expect(registry.metrics()).resolves.toContain(
            "soundspan_vibe_provider_status_fresh 0",
        );
    });
});
