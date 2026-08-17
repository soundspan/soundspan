import {
    compareAudioEmbeddings,
    cosineSimilarity,
    evaluateGate,
    median,
    percentile,
    textQueryOverlap,
    topKOverlap,
} from "../providerFidelity";

describe("provider fidelity metrics", () => {
    it("computes cosine, median, and interpolated percentiles", () => {
        expect(cosineSimilarity([1, 0], [0.6, 0.8])).toBeCloseTo(0.6);
        expect(median([0, 10, 20, 30])).toBe(15);
        expect(percentile([0, 10, 20, 30], 0.05)).toBeCloseTo(1.5);

        const comparison = compareAudioEmbeddings([
            { trackId: "same", a: [1, 0], b: [1, 0] },
            { trackId: "orthogonal", a: [1, 0], b: [0, 1] },
            { trackId: "opposite", a: [1, 0], b: [-1, 0] },
            { trackId: "angled", a: [1, 0], b: [0.6, 0.8] },
        ]);

        expect(comparison.perTrack).toEqual([
            { trackId: "same", cosine: 1 },
            { trackId: "orthogonal", cosine: 0 },
            { trackId: "opposite", cosine: -1 },
            { trackId: "angled", cosine: 0.6 },
        ]);
        expect(comparison.summary.mean).toBeCloseTo(0.15);
        expect(comparison.summary.median).toBeCloseTo(0.3);
        expect(comparison.summary.p05).toBeCloseTo(-0.85);
        expect(comparison.summary.min).toBe(-1);
    });

    it("reports full top-k overlap for identical vector sets", () => {
        const vectors = [
            { trackId: "one", vector: [1, 0] },
            { trackId: "two", vector: [0.8, 0.6] },
            { trackId: "three", vector: [-1, 0] },
            { trackId: "four", vector: [-0.8, -0.6] },
        ];

        const result = topKOverlap(vectors, vectors, 1);

        expect(result.perTrack.every(({ overlap }) => overlap === 1)).toBe(
            true,
        );
        expect(result.summary).toEqual({ mean: 1, median: 1, p05: 1 });
    });

    it("reports low overlap when candidate queries permute neighbor clusters", () => {
        const vectorsA = [
            { trackId: "one", vector: [1, 0] },
            { trackId: "two", vector: [0.8, 0.6] },
            { trackId: "three", vector: [-1, 0] },
            { trackId: "four", vector: [-0.8, -0.6] },
        ];
        const vectorsB = [
            { trackId: "one", vector: [-1, 0] },
            { trackId: "two", vector: [-0.8, -0.6] },
            { trackId: "three", vector: [1, 0] },
            { trackId: "four", vector: [0.8, 0.6] },
        ];

        const result = topKOverlap(vectorsA, vectorsB, 1);

        expect(result.summary).toEqual({ mean: 0, median: 0, p05: 0 });
    });

    it("compares text-tower queries against the baseline audio index", async () => {
        const audioVectors = [
            { trackId: "east", vector: [1, 0] },
            { trackId: "north", vector: [0, 1] },
            { trackId: "west", vector: [-1, 0] },
        ];
        const embedA = jest.fn(async (query: string) =>
            query === "steady" ? [1, 0] : [0, 1],
        );
        const embedB = jest.fn(async (query: string) =>
            query === "steady" ? [1, 0] : [-1, 0],
        );

        const result = await textQueryOverlap(
            ["steady", "shifted"],
            embedA,
            embedB,
            audioVectors,
            1,
        );

        expect(result.perQuery).toEqual([
            { query: "steady", overlap: 1 },
            { query: "shifted", overlap: 0 },
        ]);
        expect(result.summary).toEqual({ mean: 0.5, median: 0.5, p05: 0.05 });
    });

    it("treats exact gate thresholds as an inclusive pass", () => {
        const verdict = evaluateGate(
            {
                audio: { mean: 0.99, median: 0.98, p05: 0.95, min: 0.9 },
                topK: { mean: 0.9, median: 0.9, p05: 0.8 },
                textQuery: { mean: 0.7, median: 0.7, p05: 0.6 },
            },
            { medianCosine: 0.98, meanTopKOverlap: 0.9 },
        );

        expect(verdict).toEqual({ verdict: "same_space_pass", reasons: [] });
    });

    it("requires a distinct space when either threshold is below its boundary", () => {
        const verdict = evaluateGate(
            {
                audio: {
                    mean: 0.99,
                    median: 0.979999,
                    p05: 0.95,
                    min: 0.9,
                },
                topK: { mean: 0.899999, median: 0.9, p05: 0.8 },
                textQuery: { mean: 0.7, median: 0.7, p05: 0.6 },
            },
            { medianCosine: 0.98, meanTopKOverlap: 0.9 },
        );

        expect(verdict.verdict).toBe("distinct_space_required");
        expect(verdict.reasons).toEqual([
            "median cosine 0.979999 is below 0.98",
            "mean top-k overlap 0.899999 is below 0.9",
        ]);
    });
});
