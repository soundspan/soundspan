import { Counter, Gauge, type Registry } from "prom-client";

/**
 * Closed job outcome vocabulary: stored, embed_failed, invalid_payload,
 * track_missing, and stale_claim.
 */
export type VibeEmbedJobOutcome =
    | "stored"
    | "embed_failed"
    | "invalid_payload"
    | "track_missing"
    | "stale_claim";

/** Closed embedding-space transition vocabulary. */
export type VibeSpaceTransition = "registered" | "cutover" | "retired_cleaned";

/** Worker target-space coverage values exposed by the worker process. */
export interface VibeEmbeddingCoverage {
    embedded: number;
    pending: number;
    failed: number;
}

/** Instruments for backend-driven audio embedding work. */
export interface VibeEmbedMetrics {
    jobs: Counter<"outcome">;
    coverage: Gauge<"state">;
    spaceTransitions: Counter<"transition">;
    recordJob(outcome: VibeEmbedJobOutcome): void;
    recordSpaceTransition(transition: VibeSpaceTransition): void;
    setCoverage(values: VibeEmbeddingCoverage): void;
}

/** Registers bounded audio-embedding job and target-space coverage metrics. */
export function createVibeEmbedMetrics(registry: Registry): VibeEmbedMetrics {
    const jobs = new Counter({
        name: "soundspan_vibe_embed_jobs_total",
        help: "Backend-driven vibe embedding jobs by final outcome.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });
    const coverage = new Gauge({
        name: "soundspan_vibe_embedding_coverage",
        help: "Local-track vibe embedding coverage for the worker target space.",
        labelNames: ["state"] as const,
        registers: [registry],
    });
    const spaceTransitions = new Counter({
        name: "soundspan_vibe_space_transitions_total",
        help: "Embedding-space lifecycle transitions by bounded type.",
        labelNames: ["transition"] as const,
        registers: [registry],
    });

    return {
        jobs,
        coverage,
        spaceTransitions,
        recordJob(outcome): void {
            jobs.inc({ outcome });
        },
        recordSpaceTransition(transition): void {
            spaceTransitions.inc({ transition });
        },
        setCoverage(values): void {
            coverage.set({ state: "embedded" }, values.embedded);
            coverage.set({ state: "pending" }, values.pending);
            coverage.set({ state: "failed" }, values.failed);
        },
    };
}
