import type { Prisma } from "@prisma/client";
import { Gauge, type Registry } from "prom-client";

/** Closed loudness measurement coverage vocabulary. */
export type LoudnessCoverageState = "measured" | "unmeasured";

const MEASURED_STATE: LoudnessCoverageState = "measured";
const UNMEASURED_STATE: LoudnessCoverageState = "unmeasured";

/** Minimal Prisma surface required for scrape-time loudness collection. */
export interface LoudnessMetricsPrisma {
    track: {
        count(args: { where: Prisma.TrackWhereInput }): Promise<number>;
    };
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
): Gauge<"state"> {
    return new Gauge({
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
}
