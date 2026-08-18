import { Registry } from "prom-client";
import {
    createLoudnessMetrics,
    type LoudnessMetricsPrisma,
} from "../loudnessMetrics";

describe("loudness metrics", () => {
    it("counts measured and unmeasured completed local tracks on scrape", async () => {
        const count = jest
            .fn<Promise<number>, [unknown]>()
            .mockResolvedValueOnce(17)
            .mockResolvedValueOnce(3);
        const prisma = { track: { count } } as LoudnessMetricsPrisma;
        const registry = new Registry();
        createLoudnessMetrics(registry, prisma);

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
    });
});
