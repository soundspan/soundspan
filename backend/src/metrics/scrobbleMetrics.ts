import { Counter, type Registry } from "prom-client";
import type { ScrobbleService } from "../services/scrobbleTypes";

/** Closed provider submission outcome vocabulary. */
export const SCROBBLE_OUTCOMES = [
    "submitted",
    "retried",
    "dropped",
    "invalid_auth",
] as const;
export type ScrobbleOutcome = (typeof SCROBBLE_OUTCOMES)[number];

/** Prometheus instruments for outbound scrobbling. */
export interface ScrobbleMetrics {
    submissions: Counter<"service" | "outcome">;
}

/** Registers outbound scrobbling counters with a process-local registry. */
export function createScrobbleMetrics(registry: Registry): ScrobbleMetrics {
    return {
        submissions: new Counter({
            name: "soundspan_scrobble_forwarding_total",
            help: "Outbound scrobble forwarding outcomes by service.",
            labelNames: ["service", "outcome"] as const,
            registers: [registry],
        }),
    };
}

export type { ScrobbleService };
