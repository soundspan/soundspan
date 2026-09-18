import { Counter, Gauge, Histogram, type Registry } from "prom-client";

/** Closed outcome vocabulary for a supervised vibe map build. */
export type VibeMapBuildOutcome = "completed" | "failed";

/** Closed outcome vocabulary for an admin-requested map rebuild. */
export type VibeMapRebuildOutcome = "started" | "already_building";

/** Instruments for vibe map builds and administrator rebuild requests. */
export interface VibeMapMetrics {
    builds: Counter<"outcome">;
    buildSeconds: Histogram;
    sampled: Gauge;
    rebuildRequests: Counter<"outcome">;
    recordBuild(
        outcome: VibeMapBuildOutcome,
        seconds: number,
        sampled: boolean,
    ): void;
    recordRebuildRequest(outcome: VibeMapRebuildOutcome): void;
}

function createBuildCounter(registry: Registry): Counter<"outcome"> {
    return new Counter({
        name: "soundspan_vibe_map_builds_total",
        help: "Vibe map builds by final outcome.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });
}

function createBuildHistogram(registry: Registry): Histogram {
    return new Histogram({
        name: "soundspan_vibe_map_build_seconds",
        help: "Vibe map build duration in seconds.",
        buckets: [1, 5, 15, 30, 60, 120, 300, 600, 900],
        registers: [registry],
    });
}

function createSampledGauge(registry: Registry): Gauge {
    return new Gauge({
        name: "soundspan_vibe_map_sampled",
        help: "Whether the most recent completed vibe map build was sampled.",
        registers: [registry],
    });
}

function createRebuildCounter(registry: Registry): Counter<"outcome"> {
    return new Counter({
        name: "soundspan_vibe_map_rebuild_requests_total",
        help: "Administrator vibe map rebuild requests by bounded outcome.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });
}

/** Registers bounded vibe map build and rebuild request metrics. */
export function createVibeMapMetrics(registry: Registry): VibeMapMetrics {
    const builds = createBuildCounter(registry);
    const buildSeconds = createBuildHistogram(registry);
    const sampled = createSampledGauge(registry);
    const rebuildRequests = createRebuildCounter(registry);

    return {
        builds,
        buildSeconds,
        sampled,
        rebuildRequests,
        recordBuild(outcome, seconds, wasSampled): void {
            builds.inc({ outcome });
            buildSeconds.observe(seconds);
            if (outcome === "completed") sampled.set(wasSampled ? 1 : 0);
        },
        recordRebuildRequest(outcome): void {
            rebuildRequests.inc({ outcome });
        },
    };
}
