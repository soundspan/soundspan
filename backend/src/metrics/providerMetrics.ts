import { Counter, Histogram, type Registry } from "prom-client";

/** Closed endpoint vocabulary for provider request telemetry. */
export type VibeProviderEndpoint = "space" | "text" | "audio";

/** Closed outcome vocabulary for provider request telemetry. */
export type VibeProviderOutcome =
    | "ok"
    | "timeout"
    | "auth"
    | "contract"
    | "mismatch"
    | "error";

/** Vibe provider instruments owned by one Prometheus registry. */
export interface ProviderMetrics {
    requests: Counter<"endpoint" | "outcome">;
    duration: Histogram<"endpoint">;
    record(
        endpoint: VibeProviderEndpoint,
        outcome: VibeProviderOutcome,
        durationSeconds: number,
    ): void;
}

/** Registers bounded provider request metrics against a registry. */
export function createProviderMetrics(registry: Registry): ProviderMetrics {
    const requests = new Counter({
        name: "soundspan_vibe_provider_requests_total",
        help: "Vibe provider HTTP requests by endpoint and final outcome.",
        labelNames: ["endpoint", "outcome"] as const,
        registers: [registry],
    });
    const duration = new Histogram({
        name: "soundspan_vibe_provider_request_seconds",
        help: "Vibe provider HTTP request duration in seconds.",
        labelNames: ["endpoint"] as const,
        buckets: [
            0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
        ],
        registers: [registry],
    });

    return {
        requests,
        duration,
        record(endpoint, outcome, durationSeconds): void {
            requests.inc({ endpoint, outcome });
            duration.observe({ endpoint }, durationSeconds);
        },
    };
}
