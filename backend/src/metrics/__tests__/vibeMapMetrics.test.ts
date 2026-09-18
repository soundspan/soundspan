import { Registry } from "prom-client";
import { createVibeMapMetrics } from "../vibeMapMetrics";

describe("vibe map metrics", () => {
    it("registers the build, rebuild, and refresh metric families", () => {
        const registry = new Registry();

        createVibeMapMetrics(registry);

        expect(
            registry.getSingleMetric("soundspan_vibe_map_builds_total"),
        ).toBeDefined();
        expect(
            registry.getSingleMetric("soundspan_vibe_map_build_seconds"),
        ).toBeDefined();
        expect(
            registry.getSingleMetric("soundspan_vibe_map_sampled"),
        ).toBeDefined();
        expect(
            registry.getSingleMetric(
                "soundspan_vibe_map_rebuild_requests_total",
            ),
        ).toBeDefined();
        expect(
            registry.getSingleMetric("soundspan_vibe_map_refresh_checks_total"),
        ).toBeDefined();
    });

    it("records every bounded build outcome and observes build duration", async () => {
        const registry = new Registry();
        const metrics = createVibeMapMetrics(registry);

        metrics.recordBuild("completed", 1.25, false);
        metrics.recordBuild("failed", 2.5, false);

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_map_builds_total{outcome="completed"} 1',
        );
        expect(exposition).toContain(
            'soundspan_vibe_map_builds_total{outcome="failed"} 1',
        );
        expect(exposition).toContain(
            "soundspan_vibe_map_build_seconds_count 2",
        );
        expect(exposition).toContain(
            "soundspan_vibe_map_build_seconds_sum 3.75",
        );
    });

    it("tracks whether the most recent completed build was sampled", async () => {
        const registry = new Registry();
        const metrics = createVibeMapMetrics(registry);

        metrics.recordBuild("completed", 1, true);
        metrics.recordBuild("failed", 1, false);
        expect(await registry.metrics()).toContain(
            "soundspan_vibe_map_sampled 1",
        );

        metrics.recordBuild("completed", 1, false);
        expect(await registry.metrics()).toContain(
            "soundspan_vibe_map_sampled 0",
        );
    });

    it("records every bounded rebuild request outcome", async () => {
        const registry = new Registry();
        const metrics = createVibeMapMetrics(registry);

        metrics.recordRebuildRequest("started");
        metrics.recordRebuildRequest("already_building");

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_vibe_map_rebuild_requests_total{outcome="started"} 1',
        );
        expect(exposition).toContain(
            'soundspan_vibe_map_rebuild_requests_total{outcome="already_building"} 1',
        );
    });

    it.each([
        "fresh",
        "started",
        "lease_held",
        "throttled",
        "skipped_building",
        "failed",
    ] as const)("records the bounded refresh outcome %s", async (outcome) => {
        const registry = new Registry();
        const metrics = createVibeMapMetrics(registry);

        metrics.recordRefreshCheck(outcome);

        expect(await registry.metrics()).toContain(
            `soundspan_vibe_map_refresh_checks_total{outcome="${outcome}"} 1`,
        );
    });
});
