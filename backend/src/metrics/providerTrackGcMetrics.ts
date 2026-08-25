import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type { MappingProvider } from "../services/remoteProviders/types";

export type ProviderTrackGcProvider = MappingProvider;
export type ProviderTrackGcOutcome = "success" | "failure";

/** Current provider-track garbage collection backlog measurements. */
export interface ProviderTrackGcBacklogMetrics {
    backlog: Readonly<Record<ProviderTrackGcProvider, number>>;
    oldestCollectableAgeSeconds: Readonly<
        Record<ProviderTrackGcProvider, number>
    >;
}

/** Provider-track garbage collection instruments owned by one registry. */
export interface ProviderTrackGcMetrics {
    deleted: Counter<"provider">;
    duration: Histogram<"outcome">;
    backlog: Gauge<"provider">;
    oldestCollectableAge: Gauge<"provider">;
    record(
        outcome: ProviderTrackGcOutcome,
        durationSeconds: number,
        deleted: Readonly<Record<ProviderTrackGcProvider, number>>,
        health?: ProviderTrackGcBacklogMetrics,
    ): void;
}

/** Registers bounded provider-track garbage collection metrics. */
export function createProviderTrackGcMetrics(
    registry: Registry,
): ProviderTrackGcMetrics {
    const deleted = new Counter({
        name: "soundspan_provider_track_gc_deleted_total",
        help: "Provider track rows deleted by provider.",
        labelNames: ["provider"] as const,
        registers: [registry],
    });
    const duration = new Histogram({
        name: "soundspan_provider_track_gc_pass_seconds",
        help: "Provider track garbage collection pass duration by outcome.",
        labelNames: ["outcome"] as const,
        buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
        registers: [registry],
    });
    const backlog = new Gauge({
        name: "soundspan_provider_track_gc_backlog",
        help: "Collectable provider track rows remaining after garbage collection.",
        labelNames: ["provider"] as const,
        registers: [registry],
    });
    const oldestCollectableAge = new Gauge({
        name: "soundspan_provider_track_gc_oldest_collectable_age_seconds",
        help: "Age of the oldest collectable provider track row in seconds.",
        labelNames: ["provider"] as const,
        registers: [registry],
    });

    return {
        deleted,
        duration,
        backlog,
        oldestCollectableAge,
        record(outcome, durationSeconds, counts, health): void {
            deleted.inc({ provider: "tidal" }, counts.tidal);
            deleted.inc({ provider: "youtube" }, counts.youtube);
            duration.observe({ outcome }, durationSeconds);
            if (!health) return;
            backlog.set({ provider: "tidal" }, health.backlog.tidal);
            backlog.set({ provider: "youtube" }, health.backlog.youtube);
            oldestCollectableAge.set(
                { provider: "tidal" },
                health.oldestCollectableAgeSeconds.tidal,
            );
            oldestCollectableAge.set(
                { provider: "youtube" },
                health.oldestCollectableAgeSeconds.youtube,
            );
        },
    };
}
