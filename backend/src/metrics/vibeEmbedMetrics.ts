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

/** Closed provider configuration error vocabulary. */
export type VibeProviderConfigErrorReason = "preprocessing_mismatch";

/** Closed vocabulary compatibility failure vocabulary. */
export type VibeVocabularySpaceMismatchReason =
    | "missing_identity"
    | "space_mismatch";

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
    providerConfigErrors: Counter<"reason">;
    vocabularySpaceMismatches: Counter<"reason">;
    collectionErrors: Counter<"collector">;
    providerQueueDepth: Gauge;
    providerQueueCapacity: Gauge;
    migrationActive: Gauge;
    recordJob(outcome: VibeEmbedJobOutcome): void;
    recordSpaceTransition(transition: VibeSpaceTransition): void;
    recordProviderConfigError(reason: VibeProviderConfigErrorReason): void;
    recordVocabularySpaceMismatch(
        reason: VibeVocabularySpaceMismatchReason,
    ): void;
    setCoverage(values: VibeEmbeddingCoverage): void;
    setProviderQueueCapacity(capacity: number): void;
    setMigrationActive(active: boolean): void;
}

/** Scrape-time dependencies for provider queue instrumentation. */
export interface VibeEmbedMetricsDependencies {
    getProviderQueueDepth(): Promise<number>;
}

function createOutcomeMetrics(registry: Registry) {
    return {
        jobs: new Counter({
            name: "soundspan_vibe_embed_jobs_total",
            help: "Backend-driven vibe embedding jobs by final outcome.",
            labelNames: ["outcome"] as const,
            registers: [registry],
        }),
        coverage: new Gauge({
            name: "soundspan_vibe_embedding_coverage",
            help: "Local-track vibe embedding coverage for the worker target space.",
            labelNames: ["state"] as const,
            registers: [registry],
        }),
        spaceTransitions: new Counter({
            name: "soundspan_vibe_space_transitions_total",
            help: "Embedding-space lifecycle transitions by bounded type.",
            labelNames: ["transition"] as const,
            registers: [registry],
        }),
        providerConfigErrors: new Counter({
            name: "soundspan_vibe_provider_config_errors_total",
            help: "Vibe provider configuration errors by bounded reason.",
            labelNames: ["reason"] as const,
            registers: [registry],
        }),
    };
}

function createQueueCollectionMetrics(
    registry: Registry,
    dependencies: VibeEmbedMetricsDependencies,
): Pick<
    VibeEmbedMetrics,
    "collectionErrors" | "providerQueueDepth" | "vocabularySpaceMismatches"
> {
    const collectionErrors = new Counter({
        name: "soundspan_metrics_collection_errors_total",
        help: "Prometheus collection errors by bounded collector name.",
        labelNames: ["collector"] as const,
        registers: [registry],
    });
    const vocabularySpaceMismatches = new Counter({
        name: "soundspan_vibe_vocabulary_space_mismatches_total",
        help: "Skipped vibe vocabulary blends by bounded compatibility reason.",
        labelNames: ["reason"] as const,
        registers: [registry],
    });
    const providerQueueDepth = new Gauge({
        name: "soundspan_vibe_provider_queue_depth",
        help: "Raw Redis job depth for the backend vibe provider queue.",
        registers: [registry],
        async collect() {
            try {
                this.set(await dependencies.getProviderQueueDepth());
            } catch {
                // Keep the last successful sample. Telemetry dependency
                // failures must not make the complete scrape unavailable.
                collectionErrors.inc({ collector: "vibe_queue_depth" });
            }
        },
    });
    providerQueueDepth.reset();
    return { collectionErrors, providerQueueDepth, vocabularySpaceMismatches };
}

function createOperationalGauges(registry: Registry) {
    return {
        providerQueueCapacity: new Gauge({
            name: "soundspan_vibe_provider_queue_capacity",
            help: "Configured admission capacity for the vibe provider queue.",
            registers: [registry],
        }),
        migrationActive: new Gauge({
            name: "soundspan_vibe_migration_active",
            help: "Whether this worker is targeting a migrating vibe space.",
            registers: [registry],
        }),
    };
}

/** Registers bounded audio-embedding job and target-space coverage metrics. */
export function createVibeEmbedMetrics(
    registry: Registry,
    dependencies: VibeEmbedMetricsDependencies,
): VibeEmbedMetrics {
    const outcomeMetrics = createOutcomeMetrics(registry);
    const queueMetrics = createQueueCollectionMetrics(registry, dependencies);
    const operationalGauges = createOperationalGauges(registry);

    return {
        ...outcomeMetrics,
        ...queueMetrics,
        ...operationalGauges,
        recordJob(outcome): void {
            outcomeMetrics.jobs.inc({ outcome });
        },
        recordSpaceTransition(transition): void {
            outcomeMetrics.spaceTransitions.inc({ transition });
        },
        recordProviderConfigError(reason): void {
            outcomeMetrics.providerConfigErrors.inc({ reason });
        },
        recordVocabularySpaceMismatch(reason): void {
            queueMetrics.vocabularySpaceMismatches.inc({ reason });
        },
        setCoverage(values): void {
            outcomeMetrics.coverage.set({ state: "embedded" }, values.embedded);
            outcomeMetrics.coverage.set({ state: "pending" }, values.pending);
            outcomeMetrics.coverage.set({ state: "failed" }, values.failed);
        },
        setProviderQueueCapacity(capacity): void {
            operationalGauges.providerQueueCapacity.set(capacity);
        },
        setMigrationActive(active): void {
            operationalGauges.migrationActive.set(active ? 1 : 0);
        },
    };
}
