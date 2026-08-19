import type { Prisma } from "@prisma/client";
import { Counter, Gauge, type Registry } from "prom-client";

/** Closed loudness measurement coverage vocabulary. */
export type LoudnessCoverageState = "measured" | "unmeasured";

/** Closed loudness backfill outcome vocabulary shared with the analyzer. */
export type LoudnessBackfillOutcome =
    | "measured_success"
    | "transient_failure"
    | "permanently_skipped";

/** Bounded outcome labels used for Redis collection and exposition. */
export const LOUDNESS_BACKFILL_OUTCOMES = [
    "measured_success",
    "transient_failure",
    "permanently_skipped",
] as const satisfies readonly LoudnessBackfillOutcome[];

const LOUDNESS_OUTCOME_KEY_PREFIX = "audio:analysis:loudness:outcomes:";

const MEASURED_STATE: LoudnessCoverageState = "measured";
const UNMEASURED_STATE: LoudnessCoverageState = "unmeasured";

/** Minimal Prisma surface required for scrape-time loudness collection. */
export interface LoudnessMetricsPrisma {
    track: {
        count(args: { where: Prisma.TrackWhereInput }): Promise<number>;
    };
}

/** Scrape-time source for analyzer-owned durable outcome totals. */
export interface LoudnessMetricsDependencies {
    getBackfillOutcomes(): Promise<Record<LoudnessBackfillOutcome, number>>;
}

/** Loudness coverage and backfill outcome instruments. */
export interface LoudnessMetrics {
    coverage: Gauge<"state">;
    backfillOutcomes: Counter<"outcome">;
}

/** Returns the Redis counter key for one bounded analyzer outcome. */
export function loudnessBackfillOutcomeKey(
    outcome: LoudnessBackfillOutcome,
): string {
    return `${LOUDNESS_OUTCOME_KEY_PREFIX}${outcome}`;
}

/** Parses one non-negative Redis counter value at the metrics boundary. */
export function parseLoudnessOutcomeCount(value: string | null): number {
    if (value === null) return 0;
    if (!/^(0|[1-9]\d{0,15})$/.test(value)) {
        throw new Error("Loudness outcome counter is invalid");
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("Loudness outcome counter is invalid");
    }
    return parsed;
}

const COMMON_COVERAGE_FILTER = {
    origin: "LOCAL",
    removedAt: null,
    analysisStatus: "completed",
} satisfies Prisma.TrackWhereInput;

/** Registers local-track loudness coverage collected at scrape time. */
export function createLoudnessMetrics(
    registry: Registry,
    prisma: LoudnessMetricsPrisma,
    dependencies: LoudnessMetricsDependencies,
): LoudnessMetrics {
    const coverage = new Gauge({
        name: "soundspan_loudness_coverage",
        help: "Completed active local tracks by EBU R128 measurement state.",
        labelNames: ["state"] as const,
        registers: [registry],
        async collect() {
            const [measured, unmeasured] = await Promise.all([
                prisma.track.count({
                    where: {
                        ...COMMON_COVERAGE_FILTER,
                        loudnessLufs: { not: null },
                    },
                }),
                prisma.track.count({
                    where: {
                        ...COMMON_COVERAGE_FILTER,
                        loudnessLufs: null,
                    },
                }),
            ]);
            this.reset();
            this.set({ state: MEASURED_STATE }, measured);
            this.set({ state: UNMEASURED_STATE }, unmeasured);
        },
    });
    const backfillOutcomes = new Counter({
        name: "soundspan_loudness_backfill_outcomes_total",
        help: "Loudness-only analyzer jobs by bounded final outcome.",
        labelNames: ["outcome"] as const,
        registers: [registry],
        async collect() {
            const totals = await dependencies.getBackfillOutcomes();
            this.reset();
            for (const outcome of LOUDNESS_BACKFILL_OUTCOMES) {
                this.inc({ outcome }, totals[outcome]);
            }
        },
    });
    return { coverage, backfillOutcomes };
}
