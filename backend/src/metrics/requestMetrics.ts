import { Counter, type Registry } from "prom-client";

/** Closed action vocabulary for music request state and rejection counters. */
export const MUSIC_REQUEST_ACTIONS = [
    "created",
    "approved",
    "denied",
    "cancelled",
    "fulfilled",
    "failed",
    "rejected_duplicate",
    "rejected_cap",
] as const;

/** One bounded music request counter action. */
export type MusicRequestAction = (typeof MUSIC_REQUEST_ACTIONS)[number];

/** Prometheus instruments for the music request domain. */
export interface RequestMetrics {
    requests: Counter<"action">;
}

/** Registers the music request counter with a process-local registry. */
export function createRequestMetrics(registry: Registry): RequestMetrics {
    return {
        requests: new Counter({
            name: "soundspan_music_requests_total",
            help: "Music request state changes and rejected submissions by action.",
            labelNames: ["action"] as const,
            registers: [registry],
        }),
    };
}
