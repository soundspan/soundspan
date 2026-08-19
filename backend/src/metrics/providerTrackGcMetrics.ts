import { Counter, Histogram, type Registry } from "prom-client";

export type ProviderTrackGcProvider = "tidal" | "youtube";
export type ProviderTrackGcOutcome = "success" | "failure";

/** Provider-track garbage collection instruments owned by one registry. */
export interface ProviderTrackGcMetrics {
    deleted: Counter<"provider">;
    duration: Histogram<"outcome">;
    record(
        outcome: ProviderTrackGcOutcome,
        durationSeconds: number,
        deleted: Readonly<Record<ProviderTrackGcProvider, number>>,
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

    return {
        deleted,
        duration,
        record(outcome, durationSeconds, counts): void {
            deleted.inc({ provider: "tidal" }, counts.tidal);
            deleted.inc({ provider: "youtube" }, counts.youtube);
            duration.observe({ outcome }, durationSeconds);
        },
    };
}
