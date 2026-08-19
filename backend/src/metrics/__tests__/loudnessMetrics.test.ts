import { Registry } from "prom-client";
import {
    createLoudnessMetrics,
    parseLoudnessOutcomeCount,
    type LoudnessMetricsPrisma,
} from "../loudnessMetrics";

describe("loudness metrics", () => {
    it("rejects malformed durable outcome values", () => {
        expect(() => parseLoudnessOutcomeCount("2events")).toThrow(
            "Loudness outcome counter is invalid",
        );
    });

    it("collects coverage and durable backfill outcome counters", async () => {
        const count = jest
            .fn<Promise<number>, [unknown]>()
            .mockResolvedValueOnce(17)
            .mockResolvedValueOnce(3);
        const prisma = { track: { count } } as LoudnessMetricsPrisma;
        const registry = new Registry();
        const getBackfillOutcomes = jest.fn(async () => ({
            measured_success: 11,
            transient_failure: 4,
            permanently_skipped: 2,
        }));
        createLoudnessMetrics(registry, prisma, { getBackfillOutcomes });

        expect(count).not.toHaveBeenCalled();

        const exposition = await registry.metrics();

        const commonWhere = {
            origin: "LOCAL",
            removedAt: null,
            analysisStatus: "completed",
        };
        expect(count).toHaveBeenCalledTimes(2);
        expect(count).toHaveBeenNthCalledWith(1, {
            where: { ...commonWhere, loudnessLufs: { not: null } },
        });
        expect(count).toHaveBeenNthCalledWith(2, {
            where: { ...commonWhere, loudnessLufs: null },
        });
        expect(exposition).toContain(
            'soundspan_loudness_coverage{state="measured"} 17',
        );
        expect(exposition).toContain(
            'soundspan_loudness_coverage{state="unmeasured"} 3',
        );
        expect(exposition).toContain(
            'soundspan_loudness_backfill_outcomes_total{outcome="measured_success"} 11',
        );
        expect(exposition).toContain(
            'soundspan_loudness_backfill_outcomes_total{outcome="transient_failure"} 4',
        );
        expect(exposition).toContain(
            'soundspan_loudness_backfill_outcomes_total{outcome="permanently_skipped"} 2',
        );
    });

    it("keeps the scrape alive with last-good values when Redis rejects", async () => {
        const count = jest
            .fn<Promise<number>, [unknown]>()
            .mockResolvedValue(1);
        const registry = new Registry();
        const getBackfillOutcomes = jest
            .fn()
            .mockResolvedValueOnce({
                measured_success: 9,
                transient_failure: 2,
                permanently_skipped: 1,
            })
            .mockRejectedValueOnce(new Error("redis unavailable"));
        createLoudnessMetrics(
            registry,
            { track: { count } } as LoudnessMetricsPrisma,
            { getBackfillOutcomes },
        );

        await registry.metrics();
        const degraded = await registry.metrics();
        const next = await registry.metrics();

        expect(degraded).toContain(
            'soundspan_loudness_backfill_outcomes_total{outcome="measured_success"} 9',
        );
        expect(next).toContain(
            'soundspan_loudness_collection_errors_total{collector="loudness_outcomes"} 1',
        );
    });
});
